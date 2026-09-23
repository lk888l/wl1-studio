//! Offline USB setup, reachable only through the manual confirmation dialog.
//! The application remains unprivileged. Fixed, compiled-in setup scripts run
//! through OS authorization; no frontend-supplied paths/commands are accepted.
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::firmware::{reserve, FirmwareState};

const LICENSE: &str = concat!(
    include_str!("../resources/stlink/NOTICE.txt"),
    "\n\n",
    include_str!("../resources/stlink/SLA0048.txt")
);
#[cfg(any(target_os = "linux", test))]
const LINUX_RULE: &str = include_str!("../resources/stlink/70-wl1-stlink.rules");
#[cfg(any(target_os = "linux", test))]
const STICKS3_RULE: &str = include_str!("../resources/stlink/70-wl1-sticks3.rules");
#[cfg(any(target_os = "linux", test))]
const LINUX_SETUP: &str = include_str!("../resources/stlink/install-linux.sh");
#[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
const DRIVER: &[u8] = include_bytes!("../resources/stlink/stsw-link009.zip");
#[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
const DRIVER_SHA256: &str = "df015c7760f974e9da0f4c5a098d62c72157ea45cd0e80694eb47ab7ef28352b";
#[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
const WINDOWS_SETUP: &str = include_str!("../resources/stlink/install-windows.ps1");
#[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
const WINDOWS_ELEVATE: &str = include_str!("../resources/stlink/elevate-windows.ps1");

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsbSupport {
    platform: &'static str,
    can_install: bool,
    description: &'static str,
    license: &'static str,
}

#[tauri::command]
pub fn firmware_usb_support(sticks3: Option<bool>) -> UsbSupport {
    if sticks3.unwrap_or(false) {
        return UsbSupport {
            platform: std::env::consts::OS,
            can_install: cfg!(target_os = "linux"),
            description: if cfg!(target_os = "linux") {
                "内置 StickS3 USB 权限规则。系统授权后只对 303a:4004 应用规则，并刷新已连接设备的访问权限；完成后点击刷新烧录器。"
            } else if cfg!(target_os = "windows") {
                "StickS3 USB DAP 使用 WinUSB，固件提供自动绑定描述符。请先进入 USB DAP 并等待系统识别，再刷新烧录器。"
            } else {
                "StickS3 USB DAP 使用系统 USB 支持，无需 ST-Link 驱动。请进入 USB DAP 并关闭占用烧录器的其他软件。"
            },
            license: "",
        };
    }
    UsbSupport {
        platform: std::env::consts::OS,
        can_install: cfg!(any(
            target_os = "linux",
            all(target_os = "windows", target_arch = "x86_64")
        )),
        description: if cfg!(target_os = "linux") {
            "内置 ST-Link USB 权限规则。手动设置通过系统授权（pkexec）写入 /etc/udev/rules.d/70-wl1-stlink.rules，仅授权当前本地桌面会话访问 ST-Link，不开放其他 USB 设备。已有不同内容的同名规则不会被覆盖。"
        } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            "内置 ST 原版 STSW-LINK009 驱动，无需下载。手动设置通过 Windows UAC 授权，校验内置包及签名后安装 ST 调试/加载接口驱动；不安装 VCP/桥接驱动，不自动重启。适用于 Windows 10/11 x64。使用驱动需遵守下方 ST 许可。"
        } else if cfg!(target_os = "windows") {
            "烧录引擎已内置，但随附的 ST 驱动不支持此 Windows 架构，不能在这里安装。已有兼容 USB 驱动时可尝试使用。"
        } else {
            "烧录引擎已内置；此平台不提供 USB 驱动设置。macOS 通常不需要额外 ST-Link 驱动，但本项目尚未验证 macOS。"
        },
        license: LICENSE,
    }
}

fn validate_confirmation(confirmed: bool, sticks3: bool) -> Result<(), String> {
    if !confirmed {
        return Err("请先在应用中确认 USB 设置，再通过系统管理员授权".into());
    }
    if !firmware_usb_support(Some(sticks3)).can_install {
        return Err("当前平台不提供应用内 USB 设置".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn firmware_install_usb_support(
    app: AppHandle,
    confirmed: bool,
    sticks3: Option<bool>,
) -> Result<String, String> {
    let sticks3 = sticks3.unwrap_or(false);
    validate_confirmation(confirmed, sticks3)?;
    let guard = reserve(&app)?;
    let state = app.state::<FirmwareState>().inner().clone();
    state.progress("usb-setup", "等待系统管理员授权并设置 USB 支持…", 0, None);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let result = install_usb_support(sticks3);
        match &result {
            Ok(message) => state.progress("complete", message, 1, Some(1)),
            Err(error) => state.progress("error", error, 0, None),
        }
        result
    })
    .await
    .map_err(|error| format!("USB 设置后台任务中断: {error}"))?
}

#[cfg(target_os = "linux")]
fn install_usb_support(sticks3: bool) -> Result<String, String> {
    let (rule, family) = if sticks3 {
        (STICKS3_RULE, "sticks3")
    } else {
        (LINUX_RULE, "stlink")
    };
    let output = std::process::Command::new("/usr/bin/pkexec")
        .args(["/bin/sh", "-c", LINUX_SETUP, "wl1-usb-setup", rule, family])
        .output()
        .map_err(|error| format!("无法启动系统授权: {error}。需要桌面系统提供 /usr/bin/pkexec 和 polkit 授权代理；请勿以 root 启动整个应用"))?;
    match output.status.code() {
        Some(0) if sticks3 => Ok("StickS3 USB 权限规则已设置并应用到当前设备；请点击刷新烧录器。".into()),
        Some(0) => Ok("USB 权限规则已设置。请重新插拔烧录器，再点击刷新；仅当前活动的本地桌面用户获得访问权限。".into()),
        Some(126 | 127) => Err("系统授权已取消、被拒绝或授权代理不可用；未完成 USB 设置。可在准备好后重试。".into()),
        _ => Err(format!(
            "USB 权限设置未完成: {}。请让管理员检查同名规则及 udev 服务后重试",
            String::from_utf8_lossy(&output.stderr).chars().take(3000).collect::<String>().trim()
        )),
    }
}

#[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
fn powershell_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

#[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
fn encoded_command(script: &str) -> String {
    use base64::Engine;
    let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
fn windows_setup_command(archive: &str) -> String {
    let inner = format!(
        "$archive = {}\n$expectedHash = '{}'\n{}",
        powershell_literal(archive),
        DRIVER_SHA256,
        WINDOWS_SETUP
    );
    encoded_command(&format!(
        "$elevatedCommand = '{}'\n{}",
        encoded_command(&inner),
        WINDOWS_ELEVATE
    ))
}

#[cfg(any(all(target_os = "windows", target_arch = "x86_64"), test))]
fn windows_exit_message(code: Option<i32>) -> Result<String, String> {
    match code {
        Some(0) => Ok("Windows 已完成 ST-Link 驱动配置。请重新插拔 ST-Link 后刷新；若已有更高优先级驱动，Windows 会保留其选择，不强制替换。".into()),
        Some(3010) => Ok("ST-Link 驱动已配置，Windows 要求重启后生效。请保存工作并手动重启电脑；应用不会自动重启。".into()),
        Some(125 | 1223) => Err("已取消 Windows 管理员授权，未安装驱动。可在准备好后重试。".into()),
        _ => Err(format!("Windows 未完成 ST-Link 驱动设置（退出码 {code:?}）。请检查系统安装窗口、驱动签名信任及管理员权限；不应通过关闭签名检查来解决")),
    }
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn install_usb_support(sticks3: bool) -> Result<String, String> {
    use std::os::windows::process::CommandExt;
    if sticks3 {
        return Err("StickS3 使用系统 WinUSB，无需安装 ST-Link 驱动".into());
    }
    if crate::firmware_image::sha256(DRIVER) != DRIVER_SHA256 {
        return Err("内置 ST-Link 驱动完整性校验失败，拒绝安装".into());
    }
    let temp = tempfile::Builder::new()
        .prefix("wl1-stlink-")
        .tempdir()
        .map_err(|error| format!("无法创建驱动临时目录: {error}"))?;
    let archive = temp.path().join("stsw-link009.zip");
    std::fs::write(&archive, DRIVER).map_err(|error| format!("无法暂存内置驱动: {error}"))?;
    let archive_text = archive.to_str().ok_or("临时目录路径不是有效 Unicode")?;
    let system_root = std::env::var_os("SystemRoot").ok_or("Windows SystemRoot 未设置")?;
    let powershell = std::path::PathBuf::from(system_root)
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let output = std::process::Command::new(powershell)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            &windows_setup_command(archive_text),
        ])
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW for the unprivileged helper only.
        .output()
        .map_err(|error| format!("无法启动 Windows 系统授权: {error}"))?;
    // Keep the unprivileged ZIP alive until the elevated child has exited.
    windows_exit_message(output.status.code())
}

#[cfg(not(any(
    target_os = "linux",
    all(target_os = "windows", target_arch = "x86_64")
)))]
fn install_usb_support(_sticks3: bool) -> Result<String, String> {
    Err("当前平台不提供应用内 USB 设置".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::Engine;

    fn decode_command(command: &str) -> String {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(command)
            .unwrap();
        let utf16: Vec<_> = bytes
            .chunks_exact(2)
            .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
            .collect();
        String::from_utf16(&utf16).unwrap()
    }

    #[test]
    fn driver_archive_matches_pinned_original_and_license_is_embedded() {
        assert_eq!(crate::firmware_image::sha256(DRIVER), DRIVER_SHA256);
        assert!(LICENSE.contains(DRIVER_SHA256));
        assert!(LICENSE.contains("SLA0048 Rev4/March 2018"));
        assert!(firmware_usb_support(None)
            .license
            .contains("STMicroelectronics"));
    }

    #[test]
    fn no_confirmation_cannot_start_setup() {
        assert!(validate_confirmation(false, false)
            .unwrap_err()
            .contains("确认"));
        assert_eq!(
            validate_confirmation(true, false).is_ok(),
            firmware_usb_support(None).can_install
        );
    }

    #[test]
    fn powershell_paths_are_literals_and_encoding_preserves_unicode() {
        let path = "C:\\Users\\用户 O'Brien\\$x;`test\\driver.zip";
        assert_eq!(
            powershell_literal(path),
            "'C:\\Users\\用户 O''Brien\\$x;`test\\driver.zip'"
        );
        assert_eq!(decode_command(&encoded_command(path)), path);
        let outer = decode_command(&windows_setup_command(path));
        let encoded = outer
            .lines()
            .next()
            .unwrap()
            .strip_prefix("$elevatedCommand = '")
            .unwrap()
            .strip_suffix('\'')
            .unwrap();
        let inner = decode_command(encoded);
        assert!(inner.starts_with(&format!("$archive = {}\n", powershell_literal(path))));
        assert!(inner.contains(DRIVER_SHA256));
        assert!(inner.ends_with(WINDOWS_SETUP));
        assert!(outer.ends_with(WINDOWS_ELEVATE));
        // Windows CreateProcess has a 32,767 UTF-16 code-unit command limit.
        assert!(windows_setup_command(path).len() < 30_000);
    }

    #[test]
    fn windows_cancellation_and_reboot_requirement_are_not_plain_success() {
        assert!(windows_exit_message(Some(0)).is_ok());
        assert!(windows_exit_message(Some(3010))
            .unwrap()
            .contains("手动重启"));
        assert!(windows_exit_message(Some(125))
            .unwrap_err()
            .contains("取消"));
        assert!(windows_exit_message(Some(1)).is_err());
        assert!(windows_exit_message(None).is_err());
    }

    #[test]
    fn linux_rule_is_limited_and_existing_custom_rules_are_not_overwritten() {
        let rules: Vec<_> = LINUX_RULE
            .lines()
            .filter(|line| !line.starts_with('#') && !line.is_empty())
            .collect();
        assert_eq!(rules.len(), 1);
        assert!(rules[0].contains("ATTR{idVendor}==\"0483\""));
        assert!(rules[0].contains("ATTR{idProduct}"));
        assert!(rules[0].contains("TAG+=\"uaccess\""));
        assert!(!LINUX_RULE.contains("MODE="));
        assert!(LINUX_SETUP.contains("Refusing to overwrite"));
        assert!(LINUX_SETUP.contains("ln \"$staging\" \"$target\""));
        assert!(LINUX_SETUP.contains("--attr-match=idVendor=303a --attr-match=idProduct=4004"));
        assert!(LINUX_SETUP.contains("udevadm trigger --action=add --settle --subsystem-match=usb"));
        assert!(STICKS3_RULE.contains("ATTR{idVendor}==\"303a\", ATTR{idProduct}==\"4004\""));
        assert!(!STICKS3_RULE.contains("MODE="));
        assert!(firmware_usb_support(Some(true)).license.is_empty());
    }
}
