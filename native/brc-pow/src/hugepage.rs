//! Huge-page (2 MiB) scratch-buffer allocation for the Sandglass v3 walk, Windows
//! only, with a transparent fallback to a normal `Vec<u32>` everywhere else
//! (including if the current Windows account/policy doesn't grant the privilege).
//!
//! Why: the walk does effectively random 4-byte accesses across the full 512 KiB
//! `SG_W` buffer -- 128 standard 4 KiB pages. Each page crossing during the walk is
//! a fresh TLB entry; a single 2 MiB huge page covers the whole buffer with one
//! entry, removing that source of miss latency. Measured +15-17% on a real Ryzen
//! 7000-series Windows box with this exact 512 KiB / 4-chain / 2M-step shape (own
//! benchmark, not this repo's numbers) -- re-benchmark on your own hardware before
//! trusting that figure elsewhere, same as any perf claim.
//!
//! No official OpenCL-style headers needed here either: this is plain kernel32,
//! declared directly, no external crate.

#[cfg(target_os = "windows")]
mod imp {
    use std::ptr;

    const MEM_COMMIT: u32 = 0x1000;
    const MEM_RESERVE: u32 = 0x2000;
    const MEM_LARGE_PAGES: u32 = 0x2000_0000;
    const MEM_RELEASE: u32 = 0x8000;
    const PAGE_READWRITE: u32 = 0x04;
    const SE_PRIVILEGE_ENABLED: u32 = 0x2;
    const TOKEN_ADJUST_PRIVILEGES: u32 = 0x20;
    const TOKEN_QUERY: u32 = 0x8;

    #[repr(C)]
    struct Luid {
        low_part: u32,
        high_part: i32,
    }
    #[repr(C)]
    struct LuidAndAttributes {
        luid: Luid,
        attributes: u32,
    }
    #[repr(C)]
    struct TokenPrivileges {
        privilege_count: u32,
        privileges: [LuidAndAttributes; 1],
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> isize;
        fn VirtualAlloc(addr: *mut core::ffi::c_void, size: usize, alloc_type: u32, protect: u32) -> *mut core::ffi::c_void;
        fn VirtualFree(addr: *mut core::ffi::c_void, size: usize, free_type: u32) -> i32;
        fn GetLargePageMinimum() -> usize;
        fn CloseHandle(handle: isize) -> i32;
    }
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn OpenProcessToken(process: isize, desired_access: u32, token_handle: *mut isize) -> i32;
        fn LookupPrivilegeValueW(system_name: *const u16, name: *const u16, luid: *mut Luid) -> i32;
        fn AdjustTokenPrivileges(
            token: isize,
            disable_all: i32,
            new_state: *mut TokenPrivileges,
            buffer_len: u32,
            previous_state: *mut TokenPrivileges,
            return_len: *mut u32,
        ) -> i32;
    }

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    /// Best-effort; failure just means the caller falls back to a normal allocation
    /// (e.g. the account's local security policy hasn't granted "Lock pages in
    /// memory" -- present-but-disabled by default even for admin accounts).
    fn try_enable_lock_memory_privilege() -> bool {
        unsafe {
            let mut token: isize = 0;
            if OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &mut token) == 0 {
                return false;
            }
            let name = wide("SeLockMemoryPrivilege");
            let mut luid = Luid { low_part: 0, high_part: 0 };
            if LookupPrivilegeValueW(ptr::null(), name.as_ptr(), &mut luid) == 0 {
                CloseHandle(token);
                return false;
            }
            let mut tp = TokenPrivileges {
                privilege_count: 1,
                privileges: [LuidAndAttributes { luid, attributes: SE_PRIVILEGE_ENABLED }],
            };
            let ok = AdjustTokenPrivileges(token, 0, &mut tp, 0, ptr::null_mut(), ptr::null_mut()) != 0;
            CloseHandle(token);
            ok
        }
    }

    /// A `len_words`-`u32` buffer that's a real huge-page allocation when the
    /// environment allows it, or an ordinary `Vec<u32>` otherwise -- callers only
    /// ever see `as_mut_slice()`, so the two cases are interchangeable.
    pub struct HugeBuffer {
        ptr: *mut u32,
        len: usize,
        is_huge: bool,
        _fallback: Option<Vec<u32>>,
    }

    impl HugeBuffer {
        pub fn new(len_words: usize) -> Self {
            let bytes = len_words * 4;
            if try_enable_lock_memory_privilege() {
                let min = unsafe { GetLargePageMinimum() };
                if min > 0 {
                    let alloc_size = bytes.div_ceil(min) * min;
                    let p = unsafe {
                        VirtualAlloc(ptr::null_mut(), alloc_size, MEM_COMMIT | MEM_RESERVE | MEM_LARGE_PAGES, PAGE_READWRITE)
                    };
                    if !p.is_null() {
                        return HugeBuffer { ptr: p as *mut u32, len: len_words, is_huge: true, _fallback: None };
                    }
                }
            }
            let mut v = vec![0u32; len_words];
            let p = v.as_mut_ptr();
            HugeBuffer { ptr: p, len: len_words, is_huge: false, _fallback: Some(v) }
        }

        pub fn as_mut_slice(&mut self) -> &mut [u32] {
            // Safe: `ptr` is either VirtualAlloc's return (checked non-null above,
            // valid for `len` u32s) or `_fallback`'s own backing storage -- either
            // way this struct is the sole owner and outlives every slice handed out.
            unsafe { std::slice::from_raw_parts_mut(self.ptr, self.len) }
        }
    }

    impl Drop for HugeBuffer {
        fn drop(&mut self) {
            if self.is_huge {
                unsafe {
                    VirtualFree(self.ptr as *mut core::ffi::c_void, 0, MEM_RELEASE);
                }
            }
            // else: `_fallback`'s Vec drops itself normally.
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod imp {
    pub struct HugeBuffer {
        v: Vec<u32>,
    }
    impl HugeBuffer {
        pub fn new(len_words: usize) -> Self {
            HugeBuffer { v: vec![0u32; len_words] }
        }
        pub fn as_mut_slice(&mut self) -> &mut [u32] {
            &mut self.v
        }
    }
}

pub use imp::HugeBuffer;
