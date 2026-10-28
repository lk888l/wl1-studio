use pc_monitor_core::MonitorConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::portable;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CloseBehavior {
    Exit,
    #[default]
    Tray,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Preferences {
    pub start_in_background: bool,
    pub auto_resume: bool,
    pub close_behavior: CloseBehavior,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            start_in_background: false,
            auto_resume: true,
            close_behavior: CloseBehavior::Tray,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct SavedSettings {
    pub version: u8,
    pub preferences: Preferences,
    pub monitor_config: Option<MonitorConfig>,
    pub monitor_enabled: bool,
}

impl Default for SavedSettings {
    fn default() -> Self {
        Self {
            version: 1,
            preferences: Preferences::default(),
            monitor_config: None,
            monitor_enabled: false,
        }
    }
}

impl SavedSettings {
    fn decode(bytes: &[u8]) -> Result<Self, String> {
        let mut settings: Self =
            serde_json::from_slice(bytes).map_err(|error| format!("后台配置格式错误：{error}"))?;
        if settings.version != 1 {
            return Err("后台配置版本不受支持，请重新保存设置".into());
        }
        if let Some(config) = settings.monitor_config.take() {
            settings.monitor_config = Some(config.normalized()?.0);
        } else if settings.monitor_enabled {
            return Err("后台配置缺少设备地址，请重新启动一次监控".into());
        }
        Ok(settings)
    }

    pub fn resume_config(&self) -> Option<MonitorConfig> {
        (self.preferences.auto_resume && self.monitor_enabled)
            .then(|| self.monitor_config.clone())
            .flatten()
    }

    pub fn should_show_window(
        &self,
        tray_available: bool,
        force_show: bool,
        force_background: bool,
        startup_failed: bool,
    ) -> bool {
        force_show
            || startup_failed
            || !tray_available
            || self.monitor_config.is_none()
            || (!force_background && !self.preferences.start_in_background)
    }
}

#[derive(Default)]
pub struct SettingsStore {
    pub path: Option<PathBuf>,
    pub saved: SavedSettings,
    pub warning: Option<String>,
    pub blocked: bool,
    loaded: bool,
    dirty: bool,
    legacy_path: Option<PathBuf>,
    source: Option<PathBuf>,
}

impl SettingsStore {
    #[cfg(test)]
    pub fn load(path: PathBuf) -> Self {
        Self::load_migrating(path, None)
    }

    pub fn unavailable(warning: String) -> Self {
        Self {
            warning: Some(warning),
            blocked: true,
            ..Self::default()
        }
    }

    pub fn load_migrating(path: PathBuf, legacy_path: Option<PathBuf>) -> Self {
        let mut source = path.clone();
        let mut migrating = false;
        let loaded = portable::read(&path, 16 * 1024).and_then(|bytes| {
            if let Some(bytes) = bytes {
                return SavedSettings::decode(&bytes);
            }
            if let Some(legacy) = &legacy_path {
                source = legacy.clone();
                if let Some(bytes) = portable::read(legacy, 16 * 1024)? {
                    let saved = SavedSettings::decode(&bytes)?;
                    migrating = true;
                    return Ok(saved);
                }
            }
            Ok(SavedSettings::default())
        });
        let mut store = match loaded {
            Ok(saved) => Self {
                path: Some(path),
                saved,
                loaded: true,
                legacy_path,
                source: Some(source),
                ..Self::default()
            },
            Err(warning) => Self {
                path: Some(path),
                warning: Some(warning),
                blocked: true,
                legacy_path,
                source: Some(source),
                ..Self::default()
            },
        };
        if migrating {
            let _ = store.save();
        }
        store
    }

    pub fn save(&mut self) -> Result<(), String> {
        self.dirty = true;
        let result = self.write();
        self.warning = result.as_ref().err().cloned();
        self.blocked = !self.loaded;
        if result.is_ok() {
            self.dirty = false;
            self.source = self.path.clone();
        }
        result
    }

    fn write(&self) -> Result<(), String> {
        if !self.loaded {
            return Err(self
                .warning
                .clone()
                .unwrap_or_else(|| "后台配置尚未成功读取，已阻止覆盖".into()));
        }
        let path = self
            .path
            .as_ref()
            .ok_or("无法取得后台配置目录；设置仅在本次运行有效")?;
        let bytes = serde_json::to_vec_pretty(&self.saved).map_err(|error| error.to_string())?;
        portable::atomic_write(path, &bytes)
    }

    pub fn retry(&mut self) -> Result<(), String> {
        if self.loaded && self.dirty {
            return self.save();
        }
        let path = self.path.clone().ok_or("无法取得便携配置目录")?;
        *self = Self::load_migrating(path, self.legacy_path.clone());
        if self.blocked {
            Err(self.warning.clone().unwrap_or_default())
        } else {
            Ok(())
        }
    }

    pub fn reset_corrupt(&mut self) -> Result<(), String> {
        let path = self.path.clone().ok_or("无法取得便携配置目录")?;
        let current = Self::load_migrating(path, self.legacy_path.clone());
        if current.loaded {
            if self.loaded && self.dirty {
                return self.save();
            }
            *self = current;
            return if self.blocked {
                Err(self.warning.clone().unwrap_or_default())
            } else {
                Ok(())
            };
        }
        portable::backup_file(current.source.as_deref().ok_or("找不到损坏配置路径")?)?;
        self.saved = SavedSettings::default();
        self.loaded = true;
        self.save()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_defaults_to_tray_and_survives_serialization() {
        let legacy = SavedSettings::decode(br#"{"preferences":{"autoResume":false}}"#).unwrap();
        assert_eq!(legacy.preferences.close_behavior, CloseBehavior::Tray);
        let mut saved = legacy;
        saved.preferences.close_behavior = CloseBehavior::Exit;
        let decoded = SavedSettings::decode(&serde_json::to_vec(&saved).unwrap()).unwrap();
        assert_eq!(decoded.preferences.close_behavior, CloseBehavior::Exit);
        assert!(SavedSettings::decode(br#"{"preferences":{"closeBehavior":"unknown"}}"#).is_err());
    }

    #[test]
    fn migration_never_overwrites_local_or_deletes_the_legacy_configuration() {
        let root = portable::test_directory("background-migration");
        let legacy = root.join("old/background-v1.json");
        let local = root.join(".local/background-v1.json");
        let mut saved = configured();
        saved.preferences.close_behavior = CloseBehavior::Exit;
        let bytes = serde_json::to_vec(&saved).unwrap();
        portable::atomic_write(&legacy, &bytes).unwrap();
        let store = SettingsStore::load_migrating(local.clone(), Some(legacy.clone()));
        assert!(!store.blocked);
        assert_eq!(store.saved.preferences.close_behavior, CloseBehavior::Exit);
        assert_eq!(std::fs::read(&legacy).unwrap(), bytes);
        portable::atomic_write(&local, b"{").unwrap();
        let mut broken = SettingsStore::load_migrating(local.clone(), Some(legacy.clone()));
        assert!(broken.blocked);
        assert!(broken.save().is_err());
        assert_eq!(std::fs::read(&local).unwrap(), b"{");
        broken.reset_corrupt().unwrap();
        assert!(!broken.blocked);
        assert_eq!(broken.saved.preferences.close_behavior, CloseBehavior::Tray);
        assert_eq!(std::fs::read(legacy).unwrap(), bytes);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn configured() -> SavedSettings {
        SavedSettings {
            monitor_config: Some(MonitorConfig {
                target_ip: "192.168.4.1".into(),
                gpu_enabled: true,
                gpu_uuid: None,
                interval_ms: 500,
            }),
            monitor_enabled: true,
            ..SavedSettings::default()
        }
    }

    #[test]
    fn first_launch_and_unreachable_tray_always_show_setup() {
        assert!(SavedSettings::default().should_show_window(true, false, true, false));
        let saved = configured();
        assert!(saved.should_show_window(true, false, false, false));
        assert!(saved.should_show_window(false, false, true, false));
        assert!(saved.should_show_window(true, true, true, false));
        assert!(saved.should_show_window(true, false, true, true));
    }

    #[test]
    fn startup_preferences_and_explicit_stop_are_respected() {
        let mut saved = configured();
        assert!(saved.resume_config().is_some());
        saved.monitor_enabled = false;
        assert!(saved.resume_config().is_none());
        saved.monitor_enabled = true;
        saved.preferences.auto_resume = false;
        assert!(saved.resume_config().is_none());
        saved.preferences.start_in_background = true;
        assert!(!saved.should_show_window(true, false, false, false));
        assert!(saved.should_show_window(true, true, false, false));
        saved.preferences.start_in_background = false;
        assert!(saved.should_show_window(true, false, false, false));
        assert!(!saved.should_show_window(true, false, true, false));
    }

    #[test]
    fn gpu_collection_setting_survives_restart_and_defaults_for_legacy_config() {
        let legacy = SavedSettings::decode(
            br#"{"monitorConfig":{"targetIp":"192.168.4.1"},"monitorEnabled":true}"#,
        )
        .unwrap();
        assert!(legacy.resume_config().unwrap().gpu_enabled);

        let mut saved = configured();
        let monitor = saved.monitor_config.as_mut().unwrap();
        monitor.gpu_enabled = false;
        monitor.gpu_uuid = Some("GPU-saved".into());
        let restored = SavedSettings::decode(&serde_json::to_vec(&saved).unwrap()).unwrap();
        assert_eq!(restored.resume_config(), saved.resume_config());
        assert!(!restored.resume_config().unwrap().gpu_enabled);
    }

    #[test]
    fn malformed_settings_never_start_a_sender() {
        for json in [
            r#"{"version":2}"#,
            r#"{"monitorEnabled":true}"#,
            r#"{"monitorConfig":{"targetIp":"224.0.0.1"}}"#,
            r#"{"monitorConfig":{"targetIp":"192.168.4.1","intervalMs":1}}"#,
            "{",
        ] {
            assert!(SavedSettings::decode(json.as_bytes()).is_err(), "{json}");
        }
        let saved = configured();
        let restored = SavedSettings::decode(&serde_json::to_vec(&saved).unwrap()).unwrap();
        assert_eq!(restored.resume_config(), saved.resume_config());
    }

    #[test]
    fn failed_persistence_is_reported_and_keeps_the_current_intent() {
        let mut store = SettingsStore {
            saved: configured(),
            ..SettingsStore::default()
        };
        assert!(store.save().is_err());
        assert!(store.warning.is_some());
        assert!(store.saved.resume_config().is_some());
    }

    #[test]
    fn configuration_and_explicit_stop_survive_process_restarts() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("wl1-background-{}-{unique}", std::process::id()));
        let path = directory.join("background-v1.json");
        let mut store = SettingsStore::load(path.clone());
        assert!(store.warning.is_none());
        store.saved = configured();
        store.save().unwrap();
        let mut restored = SettingsStore::load(path.clone());
        assert_eq!(restored.saved.resume_config(), store.saved.resume_config());
        restored.saved.monitor_enabled = false;
        restored.save().unwrap();
        let stopped = SettingsStore::load(path.clone());
        assert!(stopped.saved.resume_config().is_none());
        assert_eq!(stopped.saved.monitor_config, store.saved.monitor_config);
        std::fs::write(&path, b"{").unwrap();
        let broken = SettingsStore::load(path);
        assert!(broken.warning.is_some());
        assert!(broken.saved.resume_config().is_none());
        assert!(broken.saved.should_show_window(true, false, true, true));
        std::fs::remove_dir_all(directory).unwrap();
    }
}
