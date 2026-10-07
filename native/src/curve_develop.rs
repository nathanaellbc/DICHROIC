//! First spectral stage, using the canonical web WGSL without a second shader copy.
//! Produces density before DIR; it is not the complete film/paper pipeline.
use wgpu::util::DeviceExt;
use crate::Engine;

#[allow(dead_code)]
mod fields { include!(concat!(env!("OUT_DIR"), "/core_offsets.rs")); }

pub struct CurveDevelop {
    pipeline: wgpu::ComputePipeline,
    arena: wgpu::Buffer,
    count: u32,
}

impl CurveDevelop {
    pub(crate) fn new(engine: &Engine, exposure: &[f32], density: &[f32]) -> Result<Self, String> {
        if exposure.len() < 2 || exposure.len() > 65536 || density.len() != exposure.len() * 3
            || exposure.iter().chain(density).any(|v| !v.is_finite())
            || exposure.windows(2).any(|v| v[1] <= v[0]) {
            return Err("Invalid film density profile".into());
        }
        let mut packed = Vec::with_capacity(exposure.len() * 5);
        for (i, x) in exposure.iter().enumerate() {
            packed.push(*x);
            packed.push(if i + 1 < exposure.len() { 1.0 / (exposure[i + 1] - x).max(1e-9) } else { 0.0 });
        }
        packed.extend_from_slice(density);
        let shader = format!("{}\nconst ARENA_CURVEEXPOSURE_OFFSET: u32 = 0u;\nconst ARENA_DENSITYCURVES_OFFSET: u32 = {}u;\n{}",
            include_str!(concat!(env!("OUT_DIR"), "/core_params.wgsl")), exposure.len() * 2,
            include_str!("../../src/shaders/curveDevelop.wgsl"));
        engine.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let module = engine.device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("Canonical curve development"), source: wgpu::ShaderSource::Wgsl(shader.into()),
        });
        let pipeline = engine.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("Canonical curve development"), layout: None, module: &module,
            entry_point: Some("main"), compilation_options: Default::default(), cache: None,
        });
        if let Some(error) = pollster::block_on(engine.device.pop_error_scope()) { return Err(error.to_string()); }
        let arena = engine.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: Some("Film density profile"), contents: bytemuck::cast_slice(&packed), usage: wgpu::BufferUsages::STORAGE,
        });
        Ok(Self { pipeline, arena, count: exposure.len() as u32 })
    }

    /// Bounded float tiles reuse the exposure engine's three 4 MiB scratch buffers.
    pub(crate) fn render(&self, engine: &Engine, input: &[[f32; 4]], output: &mut [[f32; 4]], gamma: f32) -> Result<(), String> {
        if input.is_empty() || input.len() != output.len() || !gamma.is_finite() || gamma <= 0.0 {
            return Err("Invalid curve development frame".into());
        }
        let controls = engine.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("Curve controls"), size: fields::BYTES as u64,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false,
        });
        let group = engine.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("Curve buffers"), layout: &self.pipeline.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: engine.input.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 1, resource: engine.output.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 2, resource: controls.as_entire_binding() },
                wgpu::BindGroupEntry { binding: 3, resource: self.arena.as_entire_binding() },
            ],
        });
        let capacity = crate::TILE_BYTES as usize / 16;
        for (source, destination) in input.chunks(capacity).zip(output.chunks_mut(capacity)) {
            let mut params = vec![0u8; fields::BYTES];
            for (offset, value) in [(fields::WIDTH, source.len() as u32), (fields::HEIGHT, 1),
                (fields::EXPOSURECOUNT, self.count), (fields::FILMGAMMA, gamma.to_bits())] {
                params[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
            }
            engine.queue.write_buffer(&controls, 0, &params);
            engine.queue.write_buffer(&engine.input, 0, bytemuck::cast_slice(source));
            let bytes = source.len() as u64 * 16;
            let mut encoder = engine.device.create_command_encoder(&Default::default());
            {
                let mut pass = encoder.begin_compute_pass(&Default::default());
                pass.set_pipeline(&self.pipeline);
                pass.set_bind_group(0, &group, &[]);
                pass.dispatch_workgroups((source.len() as u32 + 31) / 32, 1, 1);
            }
            encoder.copy_buffer_to_buffer(&engine.output, 0, &engine.readback, 0, bytes);
            engine.queue.submit(Some(encoder.finish()));
            let slice = engine.readback.slice(..bytes);
            let (sender, receiver) = std::sync::mpsc::channel();
            slice.map_async(wgpu::MapMode::Read, move |result| { let _ = sender.send(result); });
            engine.device.poll(wgpu::Maintain::Wait);
            receiver.recv().map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
            {
                let mapped = slice.get_mapped_range();
                bytemuck::cast_slice_mut(destination).copy_from_slice(&mapped);
            }
            engine.readback.unmap();
        }
        Ok(())
    }
}

#[cfg(all(test, feature = "gpu-tests"))]
mod tests {
    use super::*;
    #[test]
    fn measured_portra_curve_matches_dense_reference_samples() {
        let fixture = include_bytes!("../testdata/portra400_curve.bin");
        let count = u32::from_le_bytes(fixture[..4].try_into().unwrap()) as usize;
        let values: Vec<f32> = fixture[4..].chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap())).collect();
        assert_eq!(values.len(), count * 4);
        let (exposure, density) = values.split_at(count);
        let engine = pollster::block_on(Engine::new()).unwrap();
        let stage = CurveDevelop::new(&engine, exposure, density).unwrap();
        let input: Vec<_> = (0..4096).map(|i| {
            let x = exposure[0] - 0.5 + (exposure[count - 1] - exposure[0] + 1.0) * i as f32 / 4095.0;
            [x, x + 0.1, x - 0.1, 0.81]
        }).collect();
        let mut output = vec![[0.0; 4]; input.len()];
        stage.render(&engine, &input, &mut output, 1.0).unwrap();
        let mut max_error = 0.0f32;
        for (raw, developed) in input.iter().zip(&output) {
            for channel in 0..3 {
                let x = raw[channel];
                let expected = if x <= exposure[0] { density[channel] }
                    else if x >= exposure[count - 1] { density[(count - 1) * 3 + channel] }
                    else {
                        let lo = exposure.windows(2).position(|v| x >= v[0] && x < v[1]).unwrap();
                        let t = (x - exposure[lo]) / (exposure[lo + 1] - exposure[lo]);
                        density[lo * 3 + channel] * (1.0 - t) + density[(lo + 1) * 3 + channel] * t
                    };
                max_error = max_error.max((developed[channel] - expected).abs());
            }
            assert_eq!(developed[3], raw[3]);
        }
        assert!(max_error < 1e-5, "Portra density error: {max_error}");
    }

    #[test]
    fn canonical_curve_matches_interpolation_and_reuses_tile_buffers() {
        let engine = pollster::block_on(Engine::new()).unwrap();
        // Nonuniform samples expose incorrect inverse-delta packing and indexing.
        let exposure = [-3.0, -1.7, -0.4, 0.0, 0.6, 2.0];
        let density = [0.0,0.0,0.0, 0.1,0.2,0.15, 0.7,0.9,0.8, 1.0,1.2,1.1, 1.8,2.0,1.9, 2.8,3.0,2.9];
        let stage = CurveDevelop::new(&engine, &exposure, &density).unwrap();
        let input: Vec<_> = (0..crate::TILE_BYTES as usize / 16 + 17).map(|i| {
            let x = (i % 101) as f32 * 0.06 - 3.5;
            [x, x + 0.2, x - 0.3, 0.37]
        }).collect();
        let mut output = vec![[0.0; 4]; input.len()];
        for gamma in [1.0, 0.8, 1.2] {
            stage.render(&engine, &input, &mut output, gamma).unwrap();
            for (raw, developed) in input.iter().zip(&output) {
                for channel in 0..3 {
                    let x = raw[channel] * gamma;
                    let expected = if x <= exposure[0] { density[channel] }
                        else if x >= exposure[5] { density[15 + channel] }
                        else {
                            let lo = exposure.windows(2).position(|v| x >= v[0] && x < v[1]).unwrap();
                            let t = (x - exposure[lo]) / (exposure[lo + 1] - exposure[lo]);
                            density[lo * 3 + channel] * (1.0 - t) + density[(lo + 1) * 3 + channel] * t
                        };
                    assert!((developed[channel] - expected).abs() < 1e-5, "density mismatch");
                }
                assert_eq!(developed[3], raw[3]);
            }
        }
        assert!(stage.render(&engine, &input, &mut output, f32::NAN).is_err());
        assert!(CurveDevelop::new(&engine, &[0.0, 0.0], &[0.0; 6]).is_err());
    }
}
