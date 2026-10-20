use pc_monitor_core::MonitorConfig;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct Preferences {
    pub start_in_background: bool,
    pub auto_resume: bool,
}

impl Default for Preferences {
    fn default() -> Self {
        Self {
            start_in_background: true,
            auto_resume: true,
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
}

impl SettingsStore {
    pub fn load(path: PathBuf) -> Self {
        let loaded = match std::fs::read(&path) {
            Ok(bytes) => SavedSettings::decode(&bytes),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(SavedSettings::default())
            }
            Err(error) => Err(format!("无法读取后台配置：{error}")),
        };
        match loaded {
            Ok(saved) => Self {
                path: Some(path),
                saved,
                warning: None,
            },
            Err(warning) => Self {
                path: Some(path),
                warning: Some(warning),
                ..Self::default()
            },
        }
    }

    pub fn save(&mut self) -> Result<(), String> {
        let result = self.write();
        self.warning = result.as_ref().err().cloned();
        result
    }

    fn write(&self) -> Result<(), String> {
        let path = self
            .path
            .as_ref()
            .ok_or("无法取得后台配置目录；设置仅在本次运行有效")?;
        let parent = path.parent().ok_or("后台配置路径无效")?;
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建后台配置目录：{error}"))?;
        let bytes = serde_json::to_vec_pretty(&self.saved).map_err(|error| error.to_string())?;
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, bytes)
            .and_then(|()| std::fs::rename(&temporary, path))
            .map_err(|error| format!("后台设置保存失败，仅在本次运行有效：{error}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(!saved.should_show_window(true, false, false, false));
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
