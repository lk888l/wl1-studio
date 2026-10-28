use pc_monitor_core::MonitorSnapshot;
use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "windows"))]
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
#[cfg(not(target_os = "windows"))]
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

const RESOURCE_INTERVAL: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsage {
    pub cpu_pct: Option<f32>,
    pub memory_bytes: Option<u64>,
    pub backend_cpu_pct: Option<f32>,
    pub backend_memory_bytes: Option<u64>,
    pub process_count: usize,
    pub tx_bytes_per_second: Option<f64>,
    pub packets_per_second: Option<f64>,
}

struct Baseline {
    at: Instant,
    session: Option<String>,
    bytes: u64,
    packets: u64,
}

#[derive(Default)]
pub struct ResourceSampler {
    #[cfg(target_os = "windows")]
    processes: pc_monitor_windows::ProcessTreeSampler,
    #[cfg(not(target_os = "windows"))]
    ancestry: System,
    #[cfg(not(target_os = "windows"))]
    system: System,
    baseline: Option<Baseline>,
    cached: ResourceUsage,
}

#[cfg(not(target_os = "windows"))]
fn descendants(root: Pid, parents: impl Iterator<Item = (Pid, Option<Pid>)>) -> Vec<Pid> {
    let mut children: HashMap<Pid, Vec<Pid>> = HashMap::new();
    for (pid, parent) in parents {
        if let Some(parent) = parent {
            children.entry(parent).or_default().push(pid);
        }
    }
    let mut visited = HashSet::from([root]);
    let mut result = vec![root];
    let mut index = 0;
    while let Some(pid) = result.get(index).copied() {
        if let Some(children) = children.get(&pid) {
            for &child in children {
                if visited.insert(child) {
                    result.push(child);
                }
            }
        }
        index += 1;
    }
    result
}

#[cfg(not(target_os = "windows"))]
fn normalized_cpu(usage: f32, logical_cpus: usize) -> Option<f32> {
    (usage.is_finite() && logical_cpus > 0).then(|| (usage / logical_cpus as f32).clamp(0.0, 100.0))
}

impl ResourceSampler {
    /// Called only by a visible UI's snapshot request, never by the sender or a
    /// background timer. CPU/memory queries cover only our own process tree;
    /// Windows discovers ancestry at most once every three seconds.
    pub fn sample(&mut self, monitor: &MonitorSnapshot) -> ResourceUsage {
        if self
            .baseline
            .as_ref()
            .is_some_and(|last| last.at.elapsed() < RESOURCE_INTERVAL)
        {
            return self.cached.clone();
        }
        let now = Instant::now();
        let mut next = self.process_usage();
        if !monitor.running {
            next.tx_bytes_per_second = Some(0.0);
            next.packets_per_second = Some(0.0);
        } else if let Some(last) = &self.baseline {
            if last.session == monitor.session_id {
                let elapsed = now.duration_since(last.at).as_secs_f64();
                next.tx_bytes_per_second =
                    Some(monitor.bytes_sent.saturating_sub(last.bytes) as f64 / elapsed);
                next.packets_per_second =
                    Some(monitor.samples_sent.saturating_sub(last.packets) as f64 / elapsed);
            }
        }
        self.baseline = Some(Baseline {
            at: now,
            session: monitor.session_id.clone(),
            bytes: monitor.bytes_sent,
            packets: monitor.samples_sent,
        });
        self.cached = next.clone();
        next
    }

    #[cfg(target_os = "windows")]
    fn process_usage(&mut self) -> ResourceUsage {
        let usage = self.processes.sample(std::process::id());
        ResourceUsage {
            cpu_pct: usage.cpu_pct,
            memory_bytes: usage.memory_bytes,
            backend_cpu_pct: usage.backend_cpu_pct,
            backend_memory_bytes: usage.backend_memory_bytes,
            process_count: usage.process_count,
            ..ResourceUsage::default()
        }
    }

    #[cfg(not(target_os = "windows"))]
    fn process_usage(&mut self) -> ResourceUsage {
        // Process refresh only updates the global CPU on some platforms; load
        // the logical CPU list once for the same 0–100% scale as Task Manager.
        if self.system.cpus().is_empty() {
            self.system.refresh_cpu_usage();
        }
        let root = Pid::from_u32(std::process::id());
        let minimal = ProcessRefreshKind::nothing().without_tasks();
        // Linux updates per-process CPU times even for a minimal refresh. Use
        // a separate System for discovery so it cannot erase the CPU delta.
        self.ancestry
            .refresh_processes_specifics(ProcessesToUpdate::All, true, minimal);
        let pids = descendants(
            root,
            self.ancestry
                .processes()
                .iter()
                .map(|(&pid, process)| (pid, process.parent())),
        );
        self.system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            minimal.with_cpu().with_memory(),
        );
        let logical_cpus = self.system.cpus().len();
        let mut next = ResourceUsage::default();
        let mut total_cpu = 0.0;
        let mut total_memory = 0_u64;
        for pid in pids {
            if let Some(process) = self.system.process(pid) {
                total_cpu += process.cpu_usage();
                total_memory = total_memory.saturating_add(process.memory());
                next.process_count += 1;
            }
        }
        if let Some(backend) = self.system.process(root) {
            next.memory_bytes = Some(total_memory);
            next.backend_memory_bytes = Some(backend.memory());
            // A CPU percentage needs two real samples, including after resume.
            if self.baseline.is_some() {
                next.cpu_pct = normalized_cpu(total_cpu, logical_cpus);
                next.backend_cpu_pct = normalized_cpu(backend.cpu_usage(), logical_cpus);
            }
        }
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn counts_our_webview_tree_once_and_excludes_unrelated_processes() {
        let pid = Pid::from_u32;
        let selected = descendants(
            pid(10),
            [
                (pid(10), Some(pid(1))),
                (pid(11), Some(pid(10))),
                (pid(12), Some(pid(11))),
                (pid(13), Some(pid(1))),
                (pid(14), Some(pid(13))),
                (pid(10), Some(pid(12))), // Defensive cycle handling.
            ]
            .into_iter(),
        );
        assert_eq!(selected, vec![pid(10), pid(11), pid(12)]);
        assert_eq!(normalized_cpu(200.0, 8), Some(25.0));
        assert_eq!(normalized_cpu(f32::NAN, 8), None);
        assert_eq!(normalized_cpu(1.0, 0), None);
    }

    #[test]
    fn new_sessions_do_not_inherit_old_throughput_and_sampling_is_cached() {
        let mut sampler = ResourceSampler::default();
        let mut monitor = MonitorSnapshot {
            running: true,
            session_id: Some("new".into()),
            bytes_sent: 300,
            samples_sent: 1,
            ..MonitorSnapshot::default()
        };
        sampler.baseline = Some(Baseline {
            at: Instant::now() - Duration::from_secs(2),
            session: Some("old".into()),
            bytes: 10000,
            packets: 100,
        });
        assert!(sampler.sample(&monitor).tx_bytes_per_second.is_none());
        monitor.bytes_sent = 600;
        assert!(sampler.sample(&monitor).tx_bytes_per_second.is_none());
        sampler.baseline.as_mut().unwrap().at -= Duration::from_secs(2);
        let usage = sampler.sample(&monitor);
        assert!(usage
            .tx_bytes_per_second
            .is_some_and(|rate| rate > 0.0 && rate <= 150.0));
        assert!(usage.backend_memory_bytes.is_some_and(|bytes| bytes > 0));
    }

    #[test]
    fn process_discovery_does_not_erase_real_cpu_usage() {
        let mut sampler = ResourceSampler::default();
        let monitor = MonitorSnapshot::default();
        assert!(sampler.sample(&monitor).cpu_pct.is_none());
        let start = Instant::now();
        while start.elapsed() < RESOURCE_INTERVAL + Duration::from_millis(50) {
            std::hint::black_box(start.elapsed());
        }
        let usage = sampler.sample(&monitor);
        assert!(
            usage
                .backend_cpu_pct
                .is_some_and(|cpu| cpu > 0.0 && cpu <= 100.0),
            "{usage:?}"
        );
        assert!(usage.cpu_pct.is_some_and(|cpu| cpu > 0.0 && cpu <= 100.0));
    }
}
