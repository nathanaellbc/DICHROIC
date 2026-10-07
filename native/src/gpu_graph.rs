//! Native compute backend for the canonical render graph. JSON carries small
//! descriptors only; buffers cross the C boundary as bytes, never JSON pixels.
use std::{collections::HashMap, num::NonZeroU64, sync::mpsc};
use serde_json::{json, Value};

enum Resource {
    Buffer(wgpu::Buffer), Pipeline { pipeline: wgpu::ComputePipeline, bindings: Vec<u32> }, Group(wgpu::BindGroup),
    Texture(wgpu::Texture), View(wgpu::TextureView), Sampler(wgpu::Sampler),
}

pub struct GraphGpu {
    device: wgpu::Device,
    queue: wgpu::Queue,
    resources: HashMap<u64, Resource>,
    next: u64,
    allocated: u64,
    budget: u64,
}

fn number(value: &Value, field: &str) -> Result<u64, String> {
    value[field].as_u64().ok_or_else(|| format!("Missing integer {field}"))
}
fn text<'a>(value: &'a Value, field: &str) -> Result<&'a str, String> {
    value[field].as_str().ok_or_else(|| format!("Missing string {field}"))
}

impl GraphGpu {
    pub async fn new(budget: u64) -> Result<Self, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::PRIMARY,
            // Validate in development and release with the same optimized
            // shader compilation path. DEBUG disables FXC optimizations.
            flags: wgpu::InstanceFlags::VALIDATION,
            backend_options: wgpu::BackendOptions::from_env_or_default(),
            ..Default::default()
        });
        let adapter = instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None, force_fallback_adapter: false,
        }).await.ok_or("No native compute adapter")?;
        #[cfg(target_os = "ios")]
        if adapter.get_info().backend != wgpu::Backend::Metal { return Err("iOS requires Metal".into()); }
        let limits = wgpu::Limits::default().using_resolution(adapter.limits());
        let (device, queue) = adapter.request_device(&wgpu::DeviceDescriptor {
            label: Some("DICHROIC native graph"), required_features: wgpu::Features::empty(),
            required_limits: limits, memory_hints: wgpu::MemoryHints::MemoryUsage,
        }, None).await.map_err(|e| e.to_string())?;
        Ok(Self { device, queue, resources: HashMap::new(), next: 1, allocated: 0, budget })
    }

    fn insert(&mut self, resource: Resource) -> Value {
        let id = self.next;
        self.next += 1;
        self.resources.insert(id, resource);
        json!(id)
    }
    fn buffer(&self, id: u64) -> Result<&wgpu::Buffer, String> {
        match self.resources.get(&id) { Some(Resource::Buffer(v)) => Ok(v), _ => Err(format!("Unknown buffer {id}")) }
    }
    fn pipeline(&self, id: u64) -> Result<&wgpu::ComputePipeline, String> {
        match self.resources.get(&id) { Some(Resource::Pipeline { pipeline, .. }) => Ok(pipeline), _ => Err(format!("Unknown pipeline {id}")) }
    }
    fn reserve(&self, bytes: u64) -> Result<(), String> {
        if bytes == 0 || self.allocated.checked_add(bytes).map_or(true, |n| n > self.budget) {
            Err(format!("Native GPU memory budget exceeded ({bytes} bytes requested)"))
        } else { Ok(()) }
    }

    pub fn command(&mut self, value: &Value) -> Result<Value, String> {
        // A scoped error is returned to Swift instead of terminating the app on
        // a bad descriptor, unsupported format or shader compilation failure.
        self.device.push_error_scope(wgpu::ErrorFilter::OutOfMemory);
        self.device.push_error_scope(wgpu::ErrorFilter::Validation);
        let allocation_before = self.allocated;
        let next_before = self.next;
        let result = self.execute(value);
        self.device.poll(wgpu::Maintain::Wait);
        let validation = pollster::block_on(self.device.pop_error_scope());
        let oom = pollster::block_on(self.device.pop_error_scope());
        if let Some(error) = validation.or(oom) {
            // Invalid GPU handles must never remain in the resource registry.
            self.resources.retain(|id, _| *id < next_before);
            self.allocated = allocation_before;
            return Err(error.to_string());
        }
        result
    }

    fn execute(&mut self, value: &Value) -> Result<Value, String> {
        match text(value, "op")? {
            "limits" => {
                let l = self.device.limits();
                Ok(json!({"maxBufferSize": l.max_buffer_size, "maxStorageBufferBindingSize": l.max_storage_buffer_binding_size,
                    "maxComputeWorkgroupsPerDimension": l.max_compute_workgroups_per_dimension,
                    "maxTextureDimension2D": l.max_texture_dimension_2d, "maxStorageBuffersPerShaderStage": l.max_storage_buffers_per_shader_stage,
                    "maxTextureDimension3D": l.max_texture_dimension_3d, "allocatedBytes": self.allocated, "memoryBudget": self.budget}))
            }
            "buffer" => {
                let size = number(value, "size")?;
                self.reserve(size)?;
                if size > self.device.limits().max_buffer_size { return Err("Native buffer exceeds adapter limit".into()); }
                let usage = wgpu::BufferUsages::from_bits(u32::try_from(number(value, "usage")?).map_err(|e| e.to_string())?)
                    .ok_or("Invalid buffer usage")? | wgpu::BufferUsages::COPY_DST;
                let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
                    label: value["label"].as_str(), size, usage, mapped_at_creation: false,
                });
                self.allocated += size;
                Ok(self.insert(Resource::Buffer(buffer)))
            }
            "pipeline" => {
                let code = text(value, "code")?;
                let entry = text(value, "entry")?;
                let parsed = naga::front::wgsl::parse_str(code).map_err(|e| e.emit_to_string(code))?;
                let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
                    .validate(&parsed).map_err(|e| e.to_string())?;
                let index = parsed.entry_points.iter().position(|e| e.name == entry).ok_or("Missing compute entry point")?;
                let bindings = parsed.global_variables.iter().filter_map(|(handle, global)| {
                    let binding = global.binding.as_ref()?;
                    (binding.group == 0 && !info.get_entry_point(index)[handle].is_empty()).then_some(binding.binding)
                }).collect();
                let module = self.device.create_shader_module(wgpu::ShaderModuleDescriptor {
                    label: value["label"].as_str(), source: wgpu::ShaderSource::Wgsl(code.into()),
                });
                let pipeline = self.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
                    label: value["label"].as_str(), layout: None, module: &module,
                    entry_point: Some(entry), compilation_options: Default::default(), cache: None,
                });
                Ok(self.insert(Resource::Pipeline { pipeline, bindings }))
            }
            "group" => {
                let pipeline_id = number(value, "pipeline")?;
                let pipeline = self.pipeline(pipeline_id)?;
                let bindings = match self.resources.get(&pipeline_id) {
                    Some(Resource::Pipeline { bindings, .. }) => bindings,
                    _ => return Err("Unknown pipeline bindings".into()),
                };
                let items = value["entries"].as_array().ok_or("Missing bindings")?;
                let mut entries = Vec::with_capacity(items.len());
                for item in items {
                    // Dawn retains some unused globals that Naga eliminates.
                    // Match Naga's entry-point reflection, preserving every
                    // binding actually read/written by this shader.
                    if !bindings.contains(&u32::try_from(number(item, "binding")?).map_err(|e| e.to_string())?) { continue; }
                    let id = number(item, "id")?;
                    let resource = match self.resources.get(&id).ok_or("Unknown binding resource")? {
                        Resource::Buffer(buffer) => wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                            buffer, offset: item["offset"].as_u64().unwrap_or(0), size: item["size"].as_u64().and_then(NonZeroU64::new),
                        }),
                        Resource::View(view) => wgpu::BindingResource::TextureView(view),
                        Resource::Sampler(sampler) => wgpu::BindingResource::Sampler(sampler),
                        _ => return Err("Invalid binding type".into()),
                    };
                    entries.push(wgpu::BindGroupEntry { binding: u32::try_from(number(item, "binding")?).map_err(|e| e.to_string())?, resource });
                }
                let group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: value["label"].as_str(), layout: &pipeline.get_bind_group_layout(value["index"].as_u64().unwrap_or(0) as u32), entries: &entries,
                });
                Ok(self.insert(Resource::Group(group)))
            }
            "texture" => {
                let width = u32::try_from(number(value, "width")?).map_err(|e| e.to_string())?;
                let height = u32::try_from(number(value, "height")?).map_err(|e| e.to_string())?;
                let mips = value["mips"].as_u64().unwrap_or(1) as u32;
                if width == 0 || height == 0 || mips == 0 || mips > 1 + width.max(height).ilog2() { return Err("Invalid texture size".into()); }
                let format = match text(value, "format")? {
                    "rgba16float" => wgpu::TextureFormat::Rgba16Float,
                    "rgba32float" => wgpu::TextureFormat::Rgba32Float,
                    _ => return Err("Unsupported native compute texture format".into()),
                };
                let bytes: u64 = (0..mips).map(|level| u64::from((width >> level).max(1)) * u64::from((height >> level).max(1))
                    * if format == wgpu::TextureFormat::Rgba16Float { 8 } else { 16 }).sum();
                self.reserve(bytes)?;
                let usage = wgpu::TextureUsages::from_bits(number(value, "usage")? as u32).ok_or("Invalid texture usage")?;
                let texture = self.device.create_texture(&wgpu::TextureDescriptor {
                    label: value["label"].as_str(), size: wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
                    mip_level_count: mips, sample_count: 1, dimension: wgpu::TextureDimension::D2, format, usage, view_formats: &[],
                });
                self.allocated += bytes;
                Ok(self.insert(Resource::Texture(texture)))
            }
            "view" => {
                let texture = match self.resources.get(&number(value, "texture")?) { Some(Resource::Texture(v)) => v, _ => return Err("Unknown texture".into()) };
                let view = texture.create_view(&wgpu::TextureViewDescriptor {
                    base_mip_level: value["baseMipLevel"].as_u64().unwrap_or(0) as u32,
                    mip_level_count: value["mipLevelCount"].as_u64().map(|v| v as u32), ..Default::default()
                });
                Ok(self.insert(Resource::View(view)))
            }
            "sampler" => {
                let sampler = self.device.create_sampler(&wgpu::SamplerDescriptor {
                    label: value["label"].as_str(), mag_filter: wgpu::FilterMode::Linear,
                    min_filter: wgpu::FilterMode::Linear, mipmap_filter: wgpu::FilterMode::Linear, ..Default::default()
                });
                Ok(self.insert(Resource::Sampler(sampler)))
            }
            "submit" => {
                let commands = value["commands"].as_array().ok_or("Missing command list")?;
                let mut encoder = self.device.create_command_encoder(&Default::default());
                for command in commands {
                    match text(command, "op")? {
                        "dispatch" => {
                            let pipeline = self.pipeline(number(command, "pipeline")?)?;
                            let group = match self.resources.get(&number(command, "group")?) { Some(Resource::Group(v)) => v, _ => return Err("Unknown group".into()) };
                            let mut pass = encoder.begin_compute_pass(&Default::default());
                            pass.set_pipeline(pipeline);
                            pass.set_bind_group(0, group, &[]);
                            pass.dispatch_workgroups(number(command, "x")? as u32, number(command, "y")? as u32, number(command, "z")? as u32);
                        }
                        "copy" => encoder.copy_buffer_to_buffer(self.buffer(number(command, "source")?)?, number(command, "sourceOffset")?,
                            self.buffer(number(command, "dest")?)?, number(command, "destOffset")?, number(command, "size")?),
                        _ => return Err("Unknown graph command".into()),
                    }
                }
                self.queue.submit(Some(encoder.finish()));
                self.device.poll(wgpu::Maintain::Wait);
                Ok(Value::Null)
            }
            "destroy" => {
                if let Some(resource) = self.resources.remove(&number(value, "id")?) {
                    match resource {
                        Resource::Buffer(buffer) => { self.allocated -= buffer.size(); buffer.destroy(); }
                        Resource::Texture(texture) => {
                            let extent = texture.size();
                            let bpp = if texture.format() == wgpu::TextureFormat::Rgba16Float { 8 } else { 16 };
                            let bytes: u64 = (0..texture.mip_level_count()).map(|m| u64::from((extent.width >> m).max(1)) * u64::from((extent.height >> m).max(1)) * bpp).sum();
                            self.allocated -= bytes; texture.destroy();
                        }
                        _ => {}
                    }
                }
                Ok(Value::Null)
            }
            _ => Err("Unknown native GPU operation".into()),
        }
    }

    pub fn write(&self, id: u64, offset: u64, bytes: &[u8]) -> Result<(), String> {
        let buffer = self.buffer(id)?;
        if !buffer.usage().contains(wgpu::BufferUsages::COPY_DST) || offset % 4 != 0 || bytes.len() % 4 != 0 || offset.checked_add(bytes.len() as u64).map_or(true, |end| end > buffer.size()) {
            return Err("Invalid native buffer upload range".into());
        }
        self.queue.write_buffer(buffer, offset, bytes);
        Ok(())
    }

    pub fn read(&self, id: u64, offset: u64, output: &mut [u8]) -> Result<(), String> {
        let buffer = self.buffer(id)?;
        if !buffer.usage().contains(wgpu::BufferUsages::MAP_READ) || output.is_empty() || offset % 8 != 0 || output.len() % 4 != 0 || offset.checked_add(output.len() as u64).map_or(true, |end| end > buffer.size()) {
            return Err("Invalid native readback range".into());
        }
        let slice = buffer.slice(offset..offset + output.len() as u64);
        let (sender, receiver) = mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| { let _ = sender.send(result); });
        self.device.poll(wgpu::Maintain::Wait);
        receiver.recv().map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
        { let mapped = slice.get_mapped_range(); output.copy_from_slice(&mapped); }
        buffer.unmap();
        Ok(())
    }
}
