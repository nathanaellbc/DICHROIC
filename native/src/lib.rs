//! First native vertical slice: bounded GPU exposure rendering, shared by iOS and desktop tests.
//! Spectral film/paper stages are intentionally not approximated by this kernel.
use std::{cell::RefCell, ffi::{c_char, c_void, CString}, panic::{catch_unwind, AssertUnwindSafe}, sync::mpsc};
// This stage is under parity validation, not yet exposed as a finished film look.
#[allow(dead_code)]
mod curve_develop;

const TILE_PIXELS: usize = 1024 * 1024;
const TILE_BYTES: u64 = (TILE_PIXELS * 4) as u64;
const MAX_PIXELS: usize = 50_000_000;
thread_local! { static LAST_ERROR: RefCell<CString> = RefCell::new(CString::new("").unwrap()); }

fn error(message: impl AsRef<str>) {
    let message = message.as_ref().replace('\0', " ");
    LAST_ERROR.with(|slot| *slot.borrow_mut() = CString::new(message).unwrap());
}

fn image_bytes(width: u32, height: u32, ev: f32) -> Result<usize, String> {
    let pixels = (width as usize).checked_mul(height as usize).ok_or("Image dimensions overflow")?;
    if pixels == 0 || pixels > MAX_PIXELS { return Err("Photo exceeds the native 50 MP memory limit".into()); }
    if !ev.is_finite() || !(-5.0..=5.0).contains(&ev) { return Err("Exposure must be finite and between -5 and +5 EV".into()); }
    pixels.checked_mul(4).ok_or("Image byte count overflow".into())
}

struct Engine {
    device: wgpu::Device,
    queue: wgpu::Queue,
    pipeline: wgpu::ComputePipeline,
    group: wgpu::BindGroup,
    input: wgpu::Buffer,
    output: wgpu::Buffer,
    readback: wgpu::Buffer,
    controls: wgpu::Buffer,
}

impl Engine {
    async fn new() -> Result<Self, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::PRIMARY, ..Default::default()
        });
        let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None, force_fallback_adapter: false,
        }).await.ok_or("No native GPU adapter is available")?;
        #[cfg(target_os = "ios")]
        if adapter.get_info().backend != wgpu::Backend::Metal { return Err("iOS requires the native Metal backend".into()); }
        let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("Exposure native"), required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(), memory_hints: wgpu::MemoryHints::MemoryUsage,
        }, None).await.map_err(|e| e.to_string())?;
        device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Native exposure"), source: wgpu::ShaderSource::Wgsl(include_str!("exposure.wgsl").into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Native exposure"), layout: None, module: &module, entry_point: Some("main"),
            compilation_options: Default::default(), cache: None,
        });
        let buffer = |label, usage| device.create_buffer(&wgpu::BufferDescriptor {
            label: Some(label), size: TILE_BYTES, usage, mapped_at_creation: false,
        });
        let input = buffer("Tile input", wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST);
        let output = buffer("Tile output", wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC);
        let readback = buffer("Tile readback", wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST);
        let controls = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Controls"), size: 16, usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Exposure buffers"), layout: &pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: input.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: output.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: controls.as_entire_binding() },
            ],
        });
        if let Some(e) = device.pop_error_scope().await { return Err(e.to_string()); }
        Ok(Self { device, queue, pipeline, group, input, output, readback, controls })
    }

    fn render(&self, input: &[u8], output: &mut [u8], ev: f32) -> Result<(), String> {
        for (source, destination) in input.chunks(TILE_PIXELS * 4).zip(output.chunks_mut(TILE_PIXELS * 4)) {
            let count = source.len() / 4;
            let uniforms = [count as u32, ev.to_bits(), 0, 0];
            self.queue.write_buffer(&self.input, 0, source);
            self.queue.write_buffer(&self.controls, 0, bytemuck::cast_slice(&uniforms));
            let mut commands = self.device.create_command_encoder(&Default::default());
            {
                let mut pass = commands.begin_compute_pass(&wgpu::ComputePassDescriptor { label: None, timestamp_writes: None });
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &self.group, &[]);
                pass.dispatch_workgroups((count as u32).div_ceil(256), 1, 1);
            }
            let size = (source.len() as u64 + 7) & !7;
            commands.copy_buffer_to_buffer(&self.output, 0, &self.readback, 0, size);
            self.queue.submit(Some(commands.finish()));
            let slice = self.readback.slice(0..size);
            let (send, receive) = mpsc::sync_channel(1);
            slice.map_async(wgpu::MapMode::Read, move |result| { let _ = send.send(result); });
            self.device.poll(wgpu::Maintain::Wait);
            receive.recv().map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
            {
                let mapped = slice.get_mapped_range();
                destination.copy_from_slice(&mapped[..source.len()]);
            }
            self.readback.unmap();
        }
        Ok(())
    }
}

#[no_mangle]
pub extern "C" fn exposure_create() -> *mut c_void {
    match catch_unwind(AssertUnwindSafe(|| pollster::block_on(Engine::new()))) {
        Ok(Ok(engine)) => Box::into_raw(Box::new(engine)).cast(),
        Ok(Err(message)) => { error(message); std::ptr::null_mut() },
        Err(_) => { error("Native GPU initialization failed"); std::ptr::null_mut() },
    }
}

/// # Safety
/// `engine` must be an owned handle returned by exposure_create; destroy it once, while idle.
#[no_mangle]
pub unsafe extern "C" fn exposure_destroy(engine: *mut c_void) {
    if !engine.is_null() { drop(Box::from_raw(engine.cast::<Engine>())); }
}

/// # Safety
/// Input/output must be valid, nonoverlapping allocations of their advertised lengths.
/// The handle must remain alive and all calls on it must be serialized.
#[no_mangle]
pub unsafe extern "C" fn exposure_render(engine: *mut c_void, rgba: *const u8, length: usize,
    width: u32, height: u32, ev: f32, output: *mut u8, output_length: usize) -> i32 {
    let run = || -> Result<(), String> {
        let expected = image_bytes(width, height, ev)?;
        if engine.is_null() || rgba.is_null() || output.is_null() || length != expected || output_length != expected {
            return Err("Invalid native render buffers".into());
        }
        let engine = &*engine.cast::<Engine>();
        engine.render(std::slice::from_raw_parts(rgba, length), std::slice::from_raw_parts_mut(output, output_length), ev)
    };
    match catch_unwind(AssertUnwindSafe(run)) {
        Ok(Ok(())) => 0,
        Ok(Err(message)) => { error(message); -1 },
        Err(_) => { error("Native GPU rendering failed"); -1 },
    }
}

#[no_mangle]
pub extern "C" fn exposure_last_error() -> *const c_char {
    LAST_ERROR.with(|slot| slot.borrow().as_ptr())
}

/// # Safety
/// `rgba` is uniquely owned writable storage. Serialize calls on the handle.
#[no_mangle]
pub unsafe extern "C" fn exposure_render_in_place(engine: *mut c_void, rgba: *mut u8,
    length: usize, width: u32, height: u32, ev: f32) -> i32 {
    let run = || -> Result<(), String> {
        let expected = image_bytes(width, height, ev)?;
        if engine.is_null() || rgba.is_null() || length != expected {
            return Err("Invalid native in-place render buffer".into());
        }
        let engine = &*engine.cast::<Engine>();
        let pixels = std::slice::from_raw_parts_mut(rgba, length);
        let mut source = vec![0; (TILE_PIXELS * 4).min(length)];
        for destination in pixels.chunks_mut(TILE_PIXELS * 4) {
            let input = &mut source[..destination.len()];
            input.copy_from_slice(destination);
            engine.render(input, destination, ev)?;
        }
        Ok(())
    };
    match catch_unwind(AssertUnwindSafe(run)) {
        Ok(Ok(())) => 0,
        Ok(Err(message)) => { error(message); -1 },
        Err(_) => { error("Native in-place GPU rendering failed"); -1 },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn rejects_invalid_sizes_and_controls() {
        assert!(image_bytes(0, 1, 0.0).is_err());
        assert!(image_bytes(10_000, 10_000, 0.0).is_err());
        assert!(image_bytes(1, 1, f32::NAN).is_err());
        assert_eq!(image_bytes(1025, 1025, 1.0).unwrap(), 1025 * 1025 * 4);
    }
    #[test] fn ffi_rejects_invalid_buffers_without_dereferencing() {
        assert_eq!(unsafe { exposure_render(std::ptr::null_mut(), std::ptr::null(), 4, 1, 1, 0.0, std::ptr::null_mut(), 4) }, -1);
        assert_eq!(unsafe { exposure_render_in_place(std::ptr::null_mut(), std::ptr::null_mut(), 4, 1, 1, 0.0) }, -1);
        assert!(!exposure_last_error().is_null());
    }
    #[cfg(feature = "gpu-tests")]
    #[test] fn native_gpu_preserves_neutral_pixels_across_tile_boundary() {
        let engine = pollster::block_on(Engine::new()).expect("CI must provide a native GPU");
        let input: Vec<u8> = (0..1025 * 1025 * 4).map(|i| (i % 256) as u8).collect();
        let mut output = vec![0; input.len()];
        engine.render(&input, &mut output, 0.0).unwrap();
        assert!(input.iter().zip(&output).all(|(a, b)| a.abs_diff(*b) <= 1));
        assert!(input.chunks(4).zip(output.chunks(4)).all(|(a, b)| a[3] == b[3]));
        let mut in_place = input.clone();
        assert_eq!(unsafe { exposure_render_in_place(
            (&engine as *const Engine).cast_mut().cast(), in_place.as_mut_ptr(), in_place.len(),
            1025, 1025, 0.0) }, 0);
        assert_eq!(in_place, output);
        let small = vec![20, 80, 140, 255, 100, 120, 160, 12];
        let mut adjusted = vec![0; small.len()];
        engine.render(&small, &mut adjusted, 1.0).unwrap();
        let mut adjusted_in_place = small.clone();
        assert_eq!(unsafe { exposure_render_in_place(
            (&engine as *const Engine).cast_mut().cast(), adjusted_in_place.as_mut_ptr(),
            adjusted_in_place.len(), 2, 1, 1.0) }, 0);
        assert_eq!(adjusted_in_place, adjusted);
        assert!(adjusted[0] > small[0]);
        assert_eq!(adjusted[7], 12);
    }
}
