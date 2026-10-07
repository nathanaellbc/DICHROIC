#![cfg(feature = "gpu-tests")]
use exposure_native::gpu_graph::GraphGpu;
use serde_json::{json, Value};

fn id(gpu: &mut GraphGpu, value: Value) -> u64 {
    gpu.command(&value).unwrap().as_u64().unwrap()
}

#[test]
fn graph_executes_and_releases_bounded_resources() {
    let mut gpu = pollster::block_on(GraphGpu::new(4096)).unwrap();
    let input = id(&mut gpu, json!({"op":"buffer","size":16,"usage":128}));
    let output = id(&mut gpu, json!({"op":"buffer","size":16,"usage":132}));
    let readback = id(&mut gpu, json!({"op":"buffer","size":16,"usage":9}));
    gpu.write(input, 0, bytemuck::cast_slice(&[0.25f32, 0.5, 1.0, 2.0])).unwrap();
    let pipeline = id(&mut gpu, json!({"op":"pipeline","entry":"main","code":
        "@group(0) @binding(0) var<storage,read> a: array<f32>; @group(0) @binding(1) var<storage,read_write> b: array<f32>; @compute @workgroup_size(4) fn main(@builtin(global_invocation_id) id: vec3<u32>) { b[id.x] = a[id.x] * 2.0; }"}));
    let group = id(&mut gpu, json!({"op":"group","pipeline":pipeline,"entries":[
        {"binding":0,"id":input},{"binding":1,"id":output}]}));
    gpu.command(&json!({"op":"submit","commands":[
        {"op":"dispatch","pipeline":pipeline,"group":group,"x":1,"y":1,"z":1},
        {"op":"copy","source":output,"sourceOffset":0,"dest":readback,"destOffset":0,"size":16}]})).unwrap();
    let mut bytes = [0u8; 16];
    gpu.read(readback, 0, &mut bytes).unwrap();
    let actual: Vec<f32> = bytes.chunks_exact(4).map(|b| f32::from_le_bytes(b.try_into().unwrap())).collect();
    assert_eq!(actual, [0.5, 1.0, 2.0, 4.0]);
    assert!(gpu.read(output, 0, &mut bytes).is_err());
    assert!(gpu.write(input, 4, &[0; 16]).is_err());
    assert!(gpu.command(&json!({"op":"buffer","size":8192,"usage":128})).is_err());
    for resource in [group, pipeline, input, output, readback] {
        gpu.command(&json!({"op":"destroy","id":resource})).unwrap();
    }
    assert_eq!(gpu.command(&json!({"op":"limits"})).unwrap()["allocatedBytes"], 0);
}

#[test]
fn invalid_descriptors_roll_back_resource_accounting() {
    let mut gpu = pollster::block_on(GraphGpu::new(4096)).unwrap();
    // MAP_READ cannot be combined with STORAGE in portable WebGPU.
    assert!(gpu.command(&json!({"op":"buffer","size":64,"usage":129})).is_err());
    assert_eq!(gpu.command(&json!({"op":"limits"})).unwrap()["allocatedBytes"], 0);
    assert!(gpu.command(&json!({"op":"pipeline","entry":"main","code":"not valid WGSL"})).is_err());
    let texture = id(&mut gpu, json!({"op":"texture","width":8,"height":8,"mips":4,"format":"rgba16float","usage":12}));
    assert_eq!(gpu.command(&json!({"op":"limits"})).unwrap()["allocatedBytes"], 680);
    gpu.command(&json!({"op":"destroy","id":texture})).unwrap();
    assert_eq!(gpu.command(&json!({"op":"limits"})).unwrap()["allocatedBytes"], 0);
}
