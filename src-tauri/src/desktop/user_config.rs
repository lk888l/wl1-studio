use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::portable;

pub const KEYS: [&str; 9] = [
    "wl1-studio.parameter-profiles.v1",
    "wl1-studio.personalization.v1",
    "wl1-studio.connection.v1",
    "wl1-studio.pc-monitor.v1",
    "wl1-studio.calibration.v1",
    "studio.esp-c3.pet.v1",
    "cf-gui.pocket-piano.studio.v1",
    "studio.sticks3.port.v1",
    "studio.sticks3.network-host.v1",
];

pub fn validate_key(key: &str) -> Result<(), String> {
    if KEYS.contains(&key) {
        Ok(())
    } else {
        Err("不支持的用户配置项".into())
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Document {
    version: u8,
    #[serde(default)]
    legacy_import_completed: bool,
    #[serde(default)]
    entries: BTreeMap<String, Value>,
}

impl Default for Document {
    fn default() -> Self {
        Self {
            version: 1,
            legacy_import_completed: false,
            entries: BTreeMap::new(),
        }
    }
}

impl Document {
    fn decode(bytes: &[u8]) -> Result<Self, String> {
        let document: Self =
            serde_json::from_slice(bytes).map_err(|error| format!("用户配置格式错误：{error}"))?;
        if document.version != 1 {
            return Err("用户配置版本不受支持".into());
        }
        for key in document.entries.keys() {
            validate_key(key)?;
        }
        Ok(document)
    }

    fn encode(&self) -> Result<Vec<u8>, String> {
        let bytes = serde_json::to_vec(self).map_err(|error| error.to_string())?;
        if bytes.len() > portable::MAX_USER_CONFIG_BYTES {
            return Err("用户配置超过 16 MiB 大小限制".into());
        }
        Ok(bytes)
    }
}

#[derive(Default)]
pub struct UserConfigStore {
    pub path: Option<PathBuf>,
    pub warning: Option<String>,
    pub blocked: bool,
    saved: Document,
    loaded: bool,
    dirty: bool,
}

impl UserConfigStore {
    pub fn unavailable(warning: String) -> Self {
        Self {
            warning: Some(warning),
            blocked: true,
            ..Self::default()
        }
    }

    pub fn load(path: PathBuf) -> Self {
        let result = portable::read(&path, portable::MAX_USER_CONFIG_BYTES).and_then(|bytes| {
            bytes.map_or_else(|| Ok(Document::default()), |bytes| Document::decode(&bytes))
        });
        let mut store = match result {
            Ok(saved) => Self {
                path: Some(path),
                saved,
                loaded: true,
                ..Self::default()
            },
            Err(warning) => Self {
                path: Some(path),
                warning: Some(warning),
                blocked: true,
                ..Self::default()
            },
        };
        if store.loaded {
            if let Some(directory) = store.path.as_deref().and_then(std::path::Path::parent) {
                if let Err(warning) = portable::probe_directory(directory) {
                    store.warning = Some(warning);
                }
            }
        }
        store
    }

    pub fn legacy_import_completed(&self) -> bool {
        self.saved.legacy_import_completed
    }

    pub fn get(&self, key: &str) -> Result<Option<Value>, String> {
        validate_key(key)?;
        self.ensure_loaded()?;
        Ok(self.saved.entries.get(key).cloned())
    }

    fn ensure_loaded(&self) -> Result<(), String> {
        if self.loaded {
            Ok(())
        } else {
            Err(self
                .warning
                .clone()
                .unwrap_or_else(|| "用户配置尚未成功读取，已阻止覆盖".into()))
        }
    }

    fn write_document(&self, document: &Document) -> Result<(), String> {
        self.ensure_loaded()?;
        let path = self.path.as_ref().ok_or("无法取得便携配置目录")?;
        portable::atomic_write(path, &document.encode()?)
    }

    fn record(&mut self, result: &Result<(), String>) {
        self.warning = result.as_ref().err().cloned();
        self.blocked = !self.loaded;
    }

    pub fn set(&mut self, key: String, value: Value) -> Result<(), String> {
        validate_key(&key)?;
        self.ensure_loaded()?;
        let mut next = self.saved.clone();
        next.entries.insert(key, value);
        next.encode()?;
        self.saved = next;
        self.dirty = true;
        self.flush()
    }

    pub fn import(&mut self, entries: BTreeMap<String, Value>) -> Result<(), String> {
        self.ensure_loaded()?;
        for key in entries.keys() {
            validate_key(key)?;
        }
        if self.saved.legacy_import_completed {
            return Ok(());
        }
        let mut next = self.saved.clone();
        for (key, value) in entries {
            next.entries.entry(key).or_insert(value);
        }
        next.legacy_import_completed = true;
        let result = self.write_document(&next);
        self.record(&result);
        result?;
        self.saved = next;
        self.dirty = false;
        Ok(())
    }

    pub fn flush(&mut self) -> Result<(), String> {
        let result = self.write_document(&self.saved);
        self.record(&result);
        if result.is_ok() {
            self.dirty = false;
        }
        result
    }

    pub fn retry(&mut self) -> Result<(), String> {
        if self.loaded && self.dirty {
            return self.flush();
        }
        let path = self.path.clone().ok_or("无法取得便携配置目录")?;
        *self = Self::load(path);
        if self.blocked {
            Err(self.warning.clone().unwrap_or_default())
        } else {
            Ok(())
        }
    }

    pub fn reset_corrupt(&mut self) -> Result<(), String> {
        let path = self.path.clone().ok_or("无法取得便携配置目录")?;
        let current = Self::load(path.clone());
        if current.loaded {
            // A healthy file, including one repaired externally, is never reset.
            if self.loaded && self.dirty {
                return self.flush();
            }
            *self = current;
            return if self.blocked {
                Err(self.warning.clone().unwrap_or_default())
            } else {
                Ok(())
            };
        }
        portable::backup_file(&path)?;
        self.saved = Document {
            legacy_import_completed: true,
            ..Document::default()
        };
        self.loaded = true;
        self.dirty = true;
        self.flush()
    }

    pub fn reset_keys(&mut self, keys: Vec<String>) -> Result<(), String> {
        for key in &keys {
            validate_key(key)?;
        }
        if keys.is_empty() || !self.loaded {
            return self.reset_corrupt();
        }
        let path = self.path.as_ref().ok_or("无法取得便携配置目录")?;
        portable::backup_file(path)?;
        let mut next = self.saved.clone();
        for key in keys {
            next.entries.remove(&key);
        }
        next.legacy_import_completed = true;
        let result = self.write_document(&next);
        self.record(&result);
        result?;
        self.saved = next;
        self.dirty = false;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn only_nine_typed_keys_can_reach_storage() {
        assert_eq!(KEYS.len(), 9);
        assert!(validate_key("../secrets").is_err());
        assert!(Document::decode(br#"{"version":1,"entries":{"other":{}}}"#).is_err());
    }

    #[test]
    fn imports_merge_once_and_preserve_existing_values() {
        let directory = portable::test_directory("users");
        let path = directory.join("user-config-v1.json");
        let mut store = UserConfigStore::load(path.clone());
        store.set(KEYS[0].into(), json!(["local"])).unwrap();
        store
            .import(BTreeMap::from([
                (KEYS[0].into(), json!(["legacy"])),
                (KEYS[1].into(), json!({"accent":"mint"})),
            ]))
            .unwrap();
        let mut reloaded = UserConfigStore::load(path);
        assert!(reloaded.legacy_import_completed());
        assert_eq!(reloaded.get(KEYS[0]).unwrap(), Some(json!(["local"])));
        assert_eq!(
            reloaded.get(KEYS[1]).unwrap(),
            Some(json!({"accent":"mint"}))
        );
        reloaded
            .import(BTreeMap::from([(KEYS[2].into(), json!("late"))]))
            .unwrap();
        assert_eq!(reloaded.get(KEYS[2]).unwrap(), None);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn corrupt_files_cannot_be_overwritten_and_reset_creates_a_backup() {
        let directory = portable::test_directory("corrupt-users");
        let path = directory.join("user-config-v1.json");
        portable::atomic_write(&path, b"{").unwrap();
        let mut store = UserConfigStore::load(path.clone());
        assert!(store.blocked);
        assert!(store.set(KEYS[0].into(), json!([])).is_err());
        assert!(store.import(BTreeMap::new()).is_err());
        assert!(store.flush().is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"{");
        store.reset_keys(Vec::new()).unwrap();
        assert!(!store.blocked);
        assert!(store.legacy_import_completed());
        assert!(std::fs::read_dir(&directory).unwrap().any(|entry| entry
            .unwrap()
            .path()
            .extension()
            .is_some_and(|extension| extension == "bak")));
        store.set(KEYS[0].into(), json!(["keep"])).unwrap();
        store.reset_corrupt().unwrap();
        assert_eq!(store.get(KEYS[0]).unwrap(), Some(json!(["keep"])));
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn configuration_larger_than_the_monitor_rpc_limit_survives_restart() {
        let directory = portable::test_directory("large-users");
        let path = directory.join("user-config-v1.json");
        let mut store = UserConfigStore::load(path.clone());
        let value = json!("a".repeat(128 * 1024));
        store.set(KEYS[0].into(), value.clone()).unwrap();
        assert_eq!(
            UserConfigStore::load(path).get(KEYS[0]).unwrap(),
            Some(value)
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn failed_writes_keep_session_values_and_can_be_retried_without_reload() {
        let directory = portable::test_directory("unwritable-users");
        let path = directory.join("user-config-v1.json");
        let mut store = UserConfigStore::load(path.clone());
        store.set(KEYS[0].into(), json!(["old"])).unwrap();
        let temporary = path.with_extension("json.tmp");
        std::fs::create_dir(&temporary).unwrap();
        assert!(store.set(KEYS[0].into(), json!(["session"])).is_err());
        assert!(!store.blocked);
        assert!(store.warning.is_some());
        assert_eq!(store.get(KEYS[0]).unwrap(), Some(json!(["session"])));
        assert_eq!(
            UserConfigStore::load(path.clone()).get(KEYS[0]).unwrap(),
            Some(json!(["old"]))
        );
        std::fs::remove_dir(temporary).unwrap();
        store.retry().unwrap();
        assert_eq!(
            UserConfigStore::load(path).get(KEYS[0]).unwrap(),
            Some(json!(["session"]))
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn explicit_semantic_reset_backs_up_only_the_requested_keys() {
        let directory = portable::test_directory("reset-user-key");
        let path = directory.join("user-config-v1.json");
        let mut store = UserConfigStore::load(path);
        store.set(KEYS[0].into(), json!(["keep"])).unwrap();
        store.set(KEYS[5].into(), json!({"invalid":true})).unwrap();
        assert!(store.reset_keys(vec!["../escape".into()]).is_err());
        store.reset_keys(vec![KEYS[5].into()]).unwrap();
        assert_eq!(store.get(KEYS[0]).unwrap(), Some(json!(["keep"])));
        assert_eq!(store.get(KEYS[5]).unwrap(), None);
        assert!(store.legacy_import_completed());
        let backup = std::fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| path.extension().is_some_and(|extension| extension == "bak"))
            .unwrap();
        assert!(Document::decode(&std::fs::read(backup).unwrap())
            .unwrap()
            .entries
            .contains_key(KEYS[5]));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
