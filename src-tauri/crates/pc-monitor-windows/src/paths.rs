use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::path::PathBuf;
use std::ptr;
use windows_sys::core::GUID;
use windows_sys::Win32::System::Com::CoTaskMemFree;
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::UI::Shell::{
    FOLDERID_ProgramFiles, FOLDERID_ProgramFilesX64, SHGetKnownFolderPath,
};

fn system_directory() -> Result<PathBuf, String> {
    let mut buffer = vec![0_u16; 260];
    loop {
        // SAFETY: buffer is writable for exactly the number of UTF-16 units
        // passed to Windows. Windows returns the required size if it is short.
        let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if length == 0 {
            return Err(format!(
                "无法取得 Windows 系统目录：{}",
                std::io::Error::last_os_error()
            ));
        }
        if (length as usize) < buffer.len() {
            return Ok(PathBuf::from(OsString::from_wide(
                &buffer[..length as usize],
            )));
        }
        if length > 32768 {
            return Err("Windows 系统目录长度无效".into());
        }
        buffer.resize(length as usize + 1, 0);
    }
}

struct KnownFolderPath(*mut u16);

impl Drop for KnownFolderPath {
    fn drop(&mut self) {
        // SAFETY: SHGetKnownFolderPath allocates the output with the COM task
        // allocator, even on some error paths. CoTaskMemFree accepts null.
        unsafe { CoTaskMemFree(self.0.cast()) };
    }
}

fn known_folder(id: &GUID) -> Option<PathBuf> {
    let mut allocation = KnownFolderPath(ptr::null_mut());
    // SAFETY: id is a valid known-folder identifier and allocation.0 is a valid
    // output pointer. A null token requests the current user's known folder.
    let result = unsafe { SHGetKnownFolderPath(id, 0, ptr::null_mut(), &mut allocation.0) };
    if result < 0 || allocation.0.is_null() {
        return None;
    }
    // SAFETY: on success Windows guarantees an allocated, NUL-terminated UTF-16
    // string. The allocation remains live until after it has been copied.
    let path = unsafe {
        let mut length = 0;
        while *allocation.0.add(length) != 0 {
            length += 1;
        }
        OsString::from_wide(std::slice::from_raw_parts(allocation.0, length))
    };
    Some(PathBuf::from(path))
}

/// Official DCH/standard-driver locations, obtained from Windows APIs rather
/// than the working directory, PATH, or user-supplied environment variables.
/// Paths need not exist: the NVML loader reports missing/unsupported drivers.
pub fn nvml_library_paths() -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    let system = system_directory();
    if let Ok(directory) = &system {
        paths.push(directory.join("nvml.dll"));
    }
    // ProgramFiles follows the process architecture; ProgramFilesX64 also
    // covers a standard 64-bit driver install when Windows provides it.
    for id in [&FOLDERID_ProgramFiles, &FOLDERID_ProgramFilesX64] {
        if let Some(directory) = known_folder(id) {
            let path = directory
                .join("NVIDIA Corporation")
                .join("NVSMI")
                .join("nvml.dll");
            if path.is_absolute() && !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    if paths.is_empty() {
        return Err(system
            .err()
            .unwrap_or_else(|| "无法取得 NVIDIA 驱动目录".into()));
    }
    Ok(paths)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nvml_candidates_are_absolute_deduplicated_windows_locations() {
        let paths = nvml_library_paths().expect("Windows system directory is available");
        assert!(!paths.is_empty());
        for (index, path) in paths.iter().enumerate() {
            assert!(path.is_absolute(), "{path:?}");
            assert_eq!(path.file_name().unwrap(), "nvml.dll");
            assert!(!paths[..index].contains(path), "duplicate {path:?}");
        }
        assert_eq!(paths[0], system_directory().unwrap().join("nvml.dll"));
    }
}
