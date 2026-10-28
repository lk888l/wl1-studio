//! Process discovery reads Toolhelp entries only. Handles and resource queries
//! are restricted to the application's own process tree.

use std::collections::{HashMap, HashSet};
use std::io;
use std::mem::size_of;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::time::{Duration, Instant};
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_NO_MORE_FILES, FILETIME, INVALID_HANDLE_VALUE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
use windows_sys::Win32::System::Threading::{
    GetActiveProcessorCount, GetProcessTimes, OpenProcess, WaitForSingleObject,
    ALL_PROCESSOR_GROUPS, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};

const DISCOVERY_INTERVAL: Duration = Duration::from_secs(3);
const TICKS_PER_SECOND: f64 = 10_000_000.0;

#[derive(Clone, Debug, Default)]
pub struct TreeUsage {
    pub cpu_pct: Option<f32>,
    pub memory_bytes: Option<u64>,
    pub backend_cpu_pct: Option<f32>,
    pub backend_memory_bytes: Option<u64>,
    pub process_count: usize,
}

#[derive(Clone, Copy)]
struct Times {
    created: u64,
    cpu: u64,
}

struct CpuBaseline {
    at: Instant,
    times: Times,
}

fn cpu_usage(
    baseline: &mut Option<CpuBaseline>,
    times: Times,
    now: Instant,
    logical_cpus: u32,
) -> Option<f32> {
    let previous = baseline.replace(CpuBaseline { at: now, times })?;
    if times.created != previous.times.created || logical_cpus == 0 {
        return None;
    }
    let elapsed = now.checked_duration_since(previous.at)?.as_secs_f64();
    let ticks = times.cpu.checked_sub(previous.times.cpu)?;
    if elapsed == 0.0 {
        return None;
    }
    let value = ticks as f64 / TICKS_PER_SECOND / elapsed / f64::from(logical_cpus) * 100.0;
    value.is_finite().then(|| value.clamp(0.0, 100.0) as f32)
}

fn filetime(value: FILETIME) -> u64 {
    (u64::from(value.dwHighDateTime) << 32) | u64::from(value.dwLowDateTime)
}

fn process_times(handle: &OwnedHandle) -> io::Result<Times> {
    let mut created = FILETIME::default();
    let mut exited = FILETIME::default();
    let mut kernel = FILETIME::default();
    let mut user = FILETIME::default();
    // SAFETY: The owned process handle stays open and all output pointers refer
    // to separate, initialized FILETIME values for the duration of this call.
    if unsafe {
        GetProcessTimes(
            handle.as_raw_handle(),
            &mut created,
            &mut exited,
            &mut kernel,
            &mut user,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(Times {
        created: filetime(created),
        cpu: filetime(kernel).saturating_add(filetime(user)),
    })
}

fn process_memory(handle: &OwnedHandle) -> io::Result<u64> {
    let size = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
    let mut memory = PROCESS_MEMORY_COUNTERS {
        cb: size,
        ..Default::default()
    };
    // SAFETY: The handle remains open, and the output struct's size and cb
    // match the buffer supplied to the Windows API.
    if unsafe { K32GetProcessMemoryInfo(handle.as_raw_handle(), &mut memory, size) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(memory.WorkingSetSize as u64)
}

struct TrackedProcess {
    handle: OwnedHandle,
    created: u64,
    baseline: Option<CpuBaseline>,
}

impl TrackedProcess {
    fn open(pid: u32) -> io::Result<Self> {
        // SAFETY: No pointers are passed, inheritance is disabled, and the
        // returned owned handle is checked before taking ownership.
        let handle = unsafe {
            OpenProcess(
                PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
                0,
                pid,
            )
        };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: OpenProcess transferred ownership of a valid process handle.
        let handle = unsafe { OwnedHandle::from_raw_handle(handle) };
        let created = process_times(&handle)?.created;
        Ok(Self {
            handle,
            created,
            baseline: None,
        })
    }

    fn running(&self) -> io::Result<bool> {
        // SAFETY: The owned handle has SYNCHRONIZE access and stays open. A
        // zero timeout only checks state; this call never waits for a process.
        match unsafe { WaitForSingleObject(self.handle.as_raw_handle(), 0) } {
            WAIT_TIMEOUT => Ok(true),
            WAIT_OBJECT_0 => Ok(false),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

fn process_parents() -> io::Result<Vec<(u32, u32)>> {
    // SAFETY: This requests a read-only process snapshot and passes no pointers.
    let handle = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if handle == INVALID_HANDLE_VALUE || handle.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: The successfully created snapshot transfers handle ownership.
    let snapshot = unsafe { OwnedHandle::from_raw_handle(handle) };
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    // SAFETY: The snapshot is live; entry is a correctly sized writable struct.
    if unsafe { Process32FirstW(snapshot.as_raw_handle(), &mut entry) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut parents = Vec::new();
    loop {
        parents.push((entry.th32ProcessID, entry.th32ParentProcessID));
        // SAFETY: The same snapshot and initialized entry remain valid.
        if unsafe { Process32NextW(snapshot.as_raw_handle(), &mut entry) } == 0 {
            // SAFETY: GetLastError has no arguments and is read immediately
            // after the failed enumeration call, before any other Windows API.
            return if unsafe { GetLastError() } == ERROR_NO_MORE_FILES {
                Ok(parents)
            } else {
                Err(io::Error::last_os_error())
            };
        }
    }
}

fn descendants(
    root: u32,
    parents: impl IntoIterator<Item = (u32, u32)>,
) -> Vec<(u32, Option<u32>)> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, parent) in parents {
        children.entry(parent).or_default().push(pid);
    }
    let mut visited = HashSet::from([root]);
    let mut result = vec![(root, None)];
    let mut index = 0;
    while let Some(&(pid, _)) = result.get(index) {
        if let Some(children) = children.get(&pid) {
            for &child in children {
                if visited.insert(child) {
                    result.push((child, Some(pid)));
                }
            }
        }
        index += 1;
    }
    result
}

#[derive(Default)]
pub struct ProcessTreeSampler {
    root: Option<u32>,
    processes: HashMap<u32, TrackedProcess>,
    last_discovery: Option<Instant>,
    discovery_complete: bool,
}

impl ProcessTreeSampler {
    /// Discovers relationships at most once every three seconds, without
    /// opening unrelated processes. Callers may query tracked resources faster.
    pub fn sample(&mut self, root: u32) -> TreeUsage {
        let now = Instant::now();
        if self.root != Some(root) {
            *self = Self {
                root: Some(root),
                ..Self::default()
            };
        }
        if self
            .last_discovery
            .is_none_or(|last| now.duration_since(last) >= DISCOVERY_INTERVAL)
        {
            self.discover(root, now);
        }
        // SAFETY: ALL_PROCESSOR_GROUPS is a documented sentinel. No pointers
        // are passed; zero on failure is treated as unavailable by cpu_usage.
        let logical_cpus = unsafe { GetActiveProcessorCount(ALL_PROCESSOR_GROUPS) };
        let mut usage = TreeUsage::default();
        let mut total_cpu = Some(0.0_f32);
        let mut total_memory = Some(0_u64);
        self.processes.retain(|&pid, process| {
            match process.running() {
                Ok(true) => {}
                Ok(false) => return false,
                Err(_) => {
                    // The tree is incomplete until discovery succeeds again;
                    // later cached samples must not present a partial total.
                    self.discovery_complete = false;
                    total_cpu = None;
                    total_memory = None;
                    return false;
                }
            }
            usage.process_count += 1;
            let cpu = match process_times(&process.handle) {
                Ok(times) => cpu_usage(&mut process.baseline, times, now, logical_cpus),
                Err(_) => {
                    process.baseline = None;
                    None
                }
            };
            let memory = process_memory(&process.handle).ok();
            total_cpu = total_cpu.zip(cpu).map(|(total, next)| total + next);
            total_memory = total_memory
                .zip(memory)
                .map(|(total, next)| total.saturating_add(next));
            if pid == root {
                usage.backend_cpu_pct = cpu;
                usage.backend_memory_bytes = memory;
            }
            true
        });
        if self.discovery_complete && self.processes.contains_key(&root) {
            usage.cpu_pct = total_cpu.map(|value| value.clamp(0.0, 100.0));
            usage.memory_bytes = total_memory;
        }
        usage
    }

    fn discover(&mut self, root: u32, now: Instant) {
        self.last_discovery = Some(now);
        let Ok(parents) = process_parents() else {
            self.discovery_complete = false;
            return;
        };
        let mut previous = std::mem::take(&mut self.processes);
        let mut complete = true;
        for (pid, parent) in descendants(root, parents) {
            // An inaccessible or stale ancestor must not let unrelated
            // descendants into the tree when a parent PID has been reused.
            if parent.is_some_and(|parent| !self.processes.contains_key(&parent)) {
                continue;
            }
            let process = previous
                .remove(&pid)
                .filter(|process| matches!(process.running(), Ok(true)))
                .map(Ok)
                .unwrap_or_else(|| TrackedProcess::open(pid));
            match process {
                Ok(process) => {
                    if parent
                        .is_some_and(|parent| self.processes[&parent].created > process.created)
                    {
                        continue;
                    }
                    self.processes.insert(pid, process);
                }
                Err(_) => complete = false,
            }
        }
        // previous drops here, releasing handles no longer in this tree.
        self.discovery_complete = complete;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    #[test]
    fn ancestry_excludes_unrelated_processes_and_cycles() {
        assert_eq!(
            descendants(10, [(10, 12), (11, 10), (12, 11), (20, 1), (21, 20)]),
            [(10, None), (11, Some(10)), (12, Some(11))]
        );
    }

    #[test]
    fn cpu_delta_is_normalized_and_new_processes_need_a_baseline() {
        let now = Instant::now();
        let mut baseline = None;
        let first = Times {
            created: 1,
            cpu: 10_000_000,
        };
        assert!(cpu_usage(&mut baseline, first, now, 8).is_none());
        let next = Times {
            cpu: 20_000_000,
            ..first
        };
        assert_eq!(
            cpu_usage(&mut baseline, next, now + Duration::from_secs(1), 8),
            Some(12.5)
        );
        assert!(cpu_usage(
            &mut baseline,
            Times { created: 2, cpu: 1 },
            now + Duration::from_secs(2),
            8
        )
        .is_none());
        assert!(cpu_usage(
            &mut baseline,
            Times { created: 2, cpu: 0 },
            now + Duration::from_secs(3),
            8
        )
        .is_none());
    }

    #[test]
    fn discovery_is_cached_and_exited_child_handles_are_released() {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "processes::tests::resource_child", "--ignored"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x08000000)
            .spawn()
            .unwrap();
        let mut sampler = ProcessTreeSampler::default();
        let root = std::process::id();
        let usage = sampler.sample(root);
        let discovered = sampler.last_discovery;
        assert!(usage.backend_memory_bytes.is_some_and(|bytes| bytes > 0));
        assert!(usage.cpu_pct.is_none());
        assert!(sampler.processes.contains_key(&child.id()));
        // Closing its pipe releases the test helper, without killing any
        // process or depending on a shell executable being available.
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
        sampler.sample(root);
        assert_eq!(sampler.last_discovery, discovered);
        assert!(!sampler.processes.contains_key(&child.id()));
    }

    #[test]
    #[ignore = "helper subprocess for discovery_is_cached_and_exited_child_handles_are_released"]
    fn resource_child() {
        let _ = std::io::stdin().read_to_end(&mut Vec::new());
    }
}
