//! Best-effort Linux worker affinity for cache-sensitive grinding.

#[cfg(target_os = "linux")]
mod imp {
    const CPU_SET_WORDS: usize = 1024 / usize::BITS as usize;

    #[repr(C)]
    struct CpuSet {
        words: [usize; CPU_SET_WORDS],
    }

    unsafe extern "C" {
        fn sched_getaffinity(pid: i32, cpusetsize: usize, mask: *mut CpuSet) -> i32;
        fn sched_setaffinity(pid: i32, cpusetsize: usize, mask: *const CpuSet) -> i32;
    }

    pub fn pin_worker_from_env() {
        let Some(index) = std::env::var("BRC_WORKER_INDEX")
            .ok()
            .and_then(|value| value.parse::<usize>().ok())
        else {
            return;
        };

        let mut allowed = CpuSet { words: [0; CPU_SET_WORDS] };
        let size = std::mem::size_of::<CpuSet>();
        if unsafe { sched_getaffinity(0, size, &mut allowed) } != 0 {
            return;
        }

        let mut cpus = Vec::new();
        for (word_index, word) in allowed.words.iter().copied().enumerate() {
            for bit in 0..usize::BITS as usize {
                if word & (1usize << bit) != 0 {
                    cpus.push(word_index * usize::BITS as usize + bit);
                }
            }
        }
        if cpus.is_empty() {
            return;
        }

        let cpu = cpus[index % cpus.len()];
        let mut selected = CpuSet { words: [0; CPU_SET_WORDS] };
        selected.words[cpu / usize::BITS as usize] = 1usize << (cpu % usize::BITS as usize);
        unsafe {
            sched_setaffinity(0, size, &selected);
        }
    }
}

#[cfg(not(target_os = "linux"))]
mod imp {
    #[inline]
    pub fn pin_worker_from_env() {}
}

pub use imp::pin_worker_from_env;
