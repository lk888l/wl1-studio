use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub const MAX_CONFIG_MESSAGE: usize = 16 * 1024 * 1024;
pub const MAX_USER_CONFIG_BYTES: usize = MAX_CONFIG_MESSAGE - 4096;

pub fn resolve_directory(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(dev)]
    {
        let _ = app;
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .ok_or("无法确定工程目录")?;
        select_directory(Some(root), Path::new(""), None)
    }
    #[cfg(not(dev))]
    {
        #[cfg(target_os = "linux")]
        let appimage = {
            use tauri::Manager;
            app.env().appimage.map(PathBuf::from)
        };
        #[cfg(not(target_os = "linux"))]
        let appimage: Option<PathBuf> = {
            let _ = app;
            None
        };
        let executable =
            std::env::current_exe().map_err(|error| format!("无法确定可执行文件目录：{error}"))?;
        select_directory(None, &executable, appimage.as_deref())
    }
}

fn select_directory(
    development_root: Option<&Path>,
    executable: &Path,
    appimage: Option<&Path>,
) -> Result<PathBuf, String> {
    let root = if let Some(root) = development_root {
        root
    } else {
        let executable = appimage.unwrap_or(executable);
        if !executable.is_absolute() {
            return Err("程序或 APPIMAGE 路径必须为绝对路径，无法选择便携配置目录".into());
        }
        executable.parent().ok_or("可执行文件路径没有父目录")?
    };
    Ok(root.join(".local"))
}

pub fn read(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取 {}：{error}", path.display())),
    };
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    if bytes.len() > limit {
        return Err(format!("{} 超过配置大小限制", path.display()));
    }
    Ok(Some(bytes))
}

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let directory = path.parent().ok_or("配置路径没有父目录")?;
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("无法创建配置目录 {}：{error}", directory.display()))?;
    let temporary = path.with_extension("json.tmp");
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)
    })();
    result.map_err(|error| format!("无法保存 {}，修改仅在本次会话有效：{error}", path.display()))
}

pub fn probe_directory(directory: &Path) -> Result<(), String> {
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("无法创建配置目录 {}：{error}", directory.display()))?;
    let probe = directory.join(format!(
        ".write-probe-{}-{}.tmp",
        std::process::id(),
        timestamp()
    ));
    let file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&probe)
        .map_err(|error| format!("配置目录 {} 不可写：{error}", directory.display()))?;
    drop(file);
    std::fs::remove_file(&probe).map_err(|error| format!("配置目录写入检查失败：{error}"))
}

#[cfg(test)]
pub fn backup(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(
        ".corrupt-{}-{}.bak",
        timestamp(),
        std::process::id()
    ));
    let backup = PathBuf::from(name);
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&backup)
        .map_err(|error| format!("无法备份损坏配置 {}：{error}", path.display()))?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("无法备份损坏配置 {}：{error}", path.display()))?;
    Ok(backup)
}

pub fn backup_file(path: &Path) -> Result<PathBuf, String> {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(
        ".corrupt-{}-{}.bak",
        timestamp(),
        std::process::id()
    ));
    let backup = PathBuf::from(name);
    let mut source = std::fs::File::open(path)
        .map_err(|error| format!("无法读取待备份配置 {}：{error}", path.display()))?;
    let mut target = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&backup)
        .map_err(|error| format!("无法创建损坏配置备份：{error}"))?;
    std::io::copy(&mut source, &mut target)
        .and_then(|_| target.sync_all())
        .map_err(|error| format!("无法完成损坏配置备份：{error}"))?;
    Ok(backup)
}

fn timestamp() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}

#[cfg(test)]
pub fn test_directory(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("wl1-{name}-{}-{}", std::process::id(), timestamp()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_paths_do_not_depend_on_the_working_directory() {
        let root = test_directory("paths");
        let executable = root.join("mounted").join("studio.exe");
        let image = root.join("distribution").join("Studio.AppImage");
        assert_eq!(
            select_directory(Some(&root), &executable, Some(&image)).unwrap(),
            root.join(".local")
        );
        assert_eq!(
            select_directory(None, &executable, None).unwrap(),
            root.join("mounted/.local")
        );
        assert_eq!(
            select_directory(None, &executable, Some(&image)).unwrap(),
            root.join("distribution/.local")
        );
        assert!(select_directory(None, &executable, Some(Path::new("relative.AppImage"))).is_err());
    }

    #[test]
    fn atomic_replacement_and_backup_preserve_complete_bytes() {
        let root = test_directory("atomic");
        let path = root.join("配置.json");
        atomic_write(&path, b"old").unwrap();
        atomic_write(&path, b"new").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        let copy = backup(&path, b"new").unwrap();
        assert_eq!(std::fs::read(copy).unwrap(), b"new");
        assert_eq!(std::fs::read(&path).unwrap(), b"new");
        std::fs::remove_dir_all(root).unwrap();
    }
}
