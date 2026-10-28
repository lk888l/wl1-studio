//! A single, language-neutral PDH counter for total CPU usage across groups.

use std::ptr::{null, null_mut};
use std::time::{Duration, Instant};
use windows_sys::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterValue,
    PdhOpenQueryW, PDH_CSTATUS_NEW_DATA, PDH_CSTATUS_VALID_DATA, PDH_FMT_COUNTERVALUE,
    PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY,
};

const MINIMUM_INTERVAL: Duration = Duration::from_millis(200);
const RETRY_INTERVAL: Duration = Duration::from_secs(5);
const TOTAL_IDLE_COUNTER: &str = r"\Processor Information(_Total)\% Idle Time";

/// Samples total CPU usage without creating counters for individual processors.
///
/// The first successful collection establishes a baseline. Failed queries return
/// no value and are rebuilt after a bounded retry delay, with a fresh baseline.
pub struct CpuSampler {
    state: Sampler<Query>,
}

impl CpuSampler {
    pub fn new() -> Self {
        Self {
            state: Sampler::new_with(Query::open, Instant::now),
        }
    }

    pub fn sample(&mut self) -> (Option<f32>, Option<String>) {
        self.state.sample_with(Query::open, Instant::now)
    }
}

impl Default for CpuSampler {
    fn default() -> Self {
        Self::new()
    }
}

trait CounterQuery {
    fn read_usage(&mut self) -> Result<f32, String>;
}

struct Query {
    query: PDH_HQUERY,
    counter: PDH_HCOUNTER,
}

// SAFETY: PDH handles have no thread affinity. This owner never exposes either
// handle, all operations require exclusive access, and Drop closes the query
// exactly once. Moving it between threads cannot cause concurrent handle use.
unsafe impl Send for Query {}

impl Query {
    fn open() -> Result<Self, String> {
        let mut query = null_mut();
        // SAFETY: null selects live local data; `query` is a valid writable out
        // parameter and remains alive for the duration of the call.
        let status = unsafe { PdhOpenQueryW(null(), 0, &mut query) };
        check_pdh(status, "初始化")?;
        if query.is_null() {
            return Err("Windows CPU 计数器未提供有效查询句柄".into());
        }
        let mut owned = Self {
            query,
            counter: null_mut(),
        };
        let path: Vec<u16> = TOTAL_IDLE_COUNTER.encode_utf16().chain(Some(0)).collect();
        // SAFETY: `owned.query` is live and owned by us; `path` is terminated,
        // and PDH writes its counter handle into a valid out parameter.
        let status =
            unsafe { PdhAddEnglishCounterW(owned.query, path.as_ptr(), 0, &mut owned.counter) };
        check_pdh(status, "注册")?;
        if owned.counter.is_null() {
            return Err("Windows CPU 计数器未提供有效计数器句柄".into());
        }
        // Establish the first raw sample without formatting it as a percentage.
        owned.collect()?;
        Ok(owned)
    }

    fn collect(&mut self) -> Result<(), String> {
        // SAFETY: only this owner accesses the live query, and it outlives the
        // collection. No asynchronous PDH collection thread is created.
        check_pdh(unsafe { PdhCollectQueryData(self.query) }, "采集")
    }
}

impl CounterQuery for Query {
    fn read_usage(&mut self) -> Result<f32, String> {
        self.collect()?;
        let mut value = PDH_FMT_COUNTERVALUE::default();
        // SAFETY: the counter belongs to our live query; `value` is writable for
        // the full structure, and the optional type out parameter may be null.
        let status = unsafe {
            PdhGetFormattedCounterValue(self.counter, PDH_FMT_DOUBLE, null_mut(), &mut value)
        };
        check_pdh(status, "读取")?;
        check_counter_status(value.CStatus)?;
        // SAFETY: the successful call above requested PDH_FMT_DOUBLE and both
        // the function result and CStatus indicate that its value is valid.
        idle_to_usage(unsafe { value.Anonymous.doubleValue })
    }
}

impl Drop for Query {
    fn drop(&mut self) {
        // SAFETY: this is the query's only owner. Closing it also removes its
        // counter, including when registration or baseline collection failed.
        unsafe { PdhCloseQuery(self.query) };
    }
}

fn check_pdh(status: u32, operation: &str) -> Result<(), String> {
    if status == 0 {
        Ok(())
    } else {
        Err(format!(
            "Windows CPU 计数器{operation}失败（PDH 0x{status:08X}）"
        ))
    }
}

fn check_counter_status(status: u32) -> Result<(), String> {
    match status {
        PDH_CSTATUS_VALID_DATA | PDH_CSTATUS_NEW_DATA => Ok(()),
        _ => Err(format!("Windows CPU 计数器数据无效（PDH 0x{status:08X}）")),
    }
}

fn idle_to_usage(idle: f64) -> Result<f32, String> {
    if idle.is_finite() && (0.0..=100.0).contains(&idle) {
        Ok((100.0 - idle) as f32)
    } else {
        Err("Windows CPU 计数器返回了无效占用率".into())
    }
}

struct Sampler<Q> {
    query: Option<Q>,
    last_collection: Option<Instant>,
    retry_at: Option<Instant>,
    warning: Option<String>,
}

impl<Q: CounterQuery> Sampler<Q> {
    fn new_with(open: impl FnOnce() -> Result<Q, String>, clock: impl Fn() -> Instant) -> Self {
        let mut state = Self {
            query: None,
            last_collection: None,
            retry_at: None,
            warning: None,
        };
        let opened = open();
        state.set_query(opened, clock());
        state
    }

    fn set_query(&mut self, opened: Result<Q, String>, now: Instant) {
        match opened {
            Ok(query) => {
                self.query = Some(query);
                self.last_collection = Some(now);
                self.retry_at = None;
                self.warning = None;
            }
            Err(warning) => {
                self.query = None;
                self.last_collection = None;
                self.retry_at = Some(now + RETRY_INTERVAL);
                self.warning = Some(warning);
            }
        }
    }

    fn sample_with(
        &mut self,
        open: impl FnOnce() -> Result<Q, String>,
        clock: impl Fn() -> Instant,
    ) -> (Option<f32>, Option<String>) {
        let now = clock();
        if self.query.is_none() {
            if self.retry_at.is_none_or(|retry| now >= retry) {
                let opened = open();
                // Initialization may be slow. Time the baseline after the raw
                // collection, so it cannot be formatted prematurely.
                self.set_query(opened, clock());
            }
            return (None, self.warning.clone());
        }
        if self
            .last_collection
            .is_some_and(|last| now.saturating_duration_since(last) < MINIMUM_INTERVAL)
        {
            return (None, None);
        }
        match self
            .query
            .as_mut()
            .expect("query checked above")
            .read_usage()
        {
            Ok(usage) => {
                self.last_collection = Some(clock());
                (Some(usage), None)
            }
            Err(warning) => {
                self.set_query(Err(warning), clock());
                (None, self.warning.clone())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::collections::VecDeque;
    use std::rc::Rc;
    use windows_sys::Win32::System::Performance::{PDH_CSTATUS_INVALID_DATA, PDH_INVALID_DATA};

    struct FakeQuery {
        values: VecDeque<Result<f32, String>>,
        reads: Rc<Cell<usize>>,
        drops: Rc<Cell<usize>>,
    }

    impl CounterQuery for FakeQuery {
        fn read_usage(&mut self) -> Result<f32, String> {
            self.reads.set(self.reads.get() + 1);
            self.values.pop_front().expect("expected a read")
        }
    }

    impl Drop for FakeQuery {
        fn drop(&mut self) {
            self.drops.set(self.drops.get() + 1);
        }
    }

    fn fake(values: Vec<Result<f32, String>>) -> FakeQuery {
        FakeQuery {
            values: values.into(),
            reads: Rc::new(Cell::new(0)),
            drops: Rc::new(Cell::new(0)),
        }
    }

    #[test]
    fn first_sample_and_short_intervals_do_not_format_a_counter() {
        let at = Instant::now();
        let query = fake(vec![Ok(37.5), Ok(25.0)]);
        let reads = Rc::clone(&query.reads);
        let mut sampler = Sampler::new_with(|| Ok(query), || at);
        assert_eq!(sampler.sample_with(|| unreachable!(), || at), (None, None));
        assert_eq!(
            sampler.sample_with(|| unreachable!(), || at + MINIMUM_INTERVAL / 2),
            (None, None)
        );
        assert_eq!(reads.get(), 0);
        assert_eq!(
            sampler.sample_with(|| unreachable!(), || at + MINIMUM_INTERVAL),
            (Some(37.5), None)
        );
        assert_eq!(
            sampler.sample_with(|| unreachable!(), || at + MINIMUM_INTERVAL),
            (None, None)
        );
        assert_eq!(
            sampler.sample_with(|| unreachable!(), || at + MINIMUM_INTERVAL * 2),
            (Some(25.0), None)
        );
        assert_eq!(reads.get(), 2);
    }

    #[test]
    fn initialization_failure_backs_off_and_recovery_needs_a_new_baseline() {
        let at = Instant::now();
        let mut sampler: Sampler<FakeQuery> =
            Sampler::new_with(|| Err("not available".into()), || at);
        assert_eq!(
            sampler.sample_with(|| panic!("must back off"), || at + MINIMUM_INTERVAL),
            (None, Some("not available".into()))
        );
        let query = fake(vec![Ok(12.0)]);
        let reads = Rc::clone(&query.reads);
        // A slow open must timestamp the baseline after it finishes.
        let calls = Cell::new(0);
        let after_open = at + RETRY_INTERVAL + Duration::from_secs(2);
        assert_eq!(
            sampler.sample_with(
                || Ok(query),
                || {
                    calls.set(calls.get() + 1);
                    if calls.get() == 1 {
                        at + RETRY_INTERVAL
                    } else {
                        after_open
                    }
                },
            ),
            (None, None)
        );
        assert_eq!(reads.get(), 0);
        assert_eq!(
            sampler.sample_with(|| unreachable!(), || after_open),
            (None, None)
        );
        assert_eq!(
            sampler.sample_with(|| unreachable!(), || after_open + MINIMUM_INTERVAL),
            (Some(12.0), None)
        );
    }

    #[test]
    fn read_failure_drops_the_old_query_and_preserves_warning_during_backoff() {
        let at = Instant::now();
        let query = fake(vec![Err("invalid data".into())]);
        let drops = Rc::clone(&query.drops);
        let mut sampler = Sampler::new_with(|| Ok(query), || at);
        let failed_at = at + MINIMUM_INTERVAL;
        assert_eq!(
            sampler.sample_with(|| unreachable!(), || failed_at),
            (None, Some("invalid data".into()))
        );
        assert_eq!(drops.get(), 1);
        assert_eq!(
            sampler.sample_with(|| panic!("must back off"), || failed_at + MINIMUM_INTERVAL),
            (None, Some("invalid data".into()))
        );
        assert_eq!(
            sampler.sample_with(|| Ok(fake(vec![Ok(7.0)])), || failed_at + RETRY_INTERVAL),
            (None, None)
        );
        assert_eq!(
            sampler.sample_with(
                || unreachable!(),
                || failed_at + RETRY_INTERVAL + MINIMUM_INTERVAL
            ),
            (Some(7.0), None)
        );
    }

    #[test]
    fn invalid_pdh_results_cannot_become_a_hundred_percent_cpu_sample() {
        assert!(check_pdh(PDH_INVALID_DATA, "读取").is_err());
        assert!(check_counter_status(PDH_CSTATUS_INVALID_DATA).is_err());
        assert!(check_counter_status(PDH_CSTATUS_VALID_DATA).is_ok());
        assert!(check_counter_status(PDH_CSTATUS_NEW_DATA).is_ok());
        for invalid in [f64::NAN, f64::INFINITY, -1.0, 101.0] {
            assert!(idle_to_usage(invalid).is_err());
        }
        assert_eq!(idle_to_usage(100.0).unwrap(), 0.0);
        assert_eq!(idle_to_usage(0.0).unwrap(), 100.0);
        assert_eq!(idle_to_usage(62.5).unwrap(), 37.5);
    }

    #[test]
    #[ignore = "requires functioning Windows performance counters"]
    fn live_total_cpu_counter_produces_a_valid_second_sample() {
        fn assert_send<T: Send>() {}
        assert_send::<CpuSampler>();
        let mut sampler = CpuSampler::new();
        let first = sampler.sample();
        assert_eq!(first, (None, None), "{first:?}");
        std::thread::sleep(Duration::from_secs(1));
        let (usage, warning) = sampler.sample();
        assert!(warning.is_none(), "{warning:?}");
        assert!(usage.is_some_and(|usage| (0.0..=100.0).contains(&usage)));
    }
}
