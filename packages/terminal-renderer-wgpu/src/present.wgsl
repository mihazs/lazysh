// Copies the persistent target to the window's swapchain image, texel for texel.
@group(0) @binding(0) var source: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) corner: u32) -> @builtin(position) vec4<f32> {
    // One triangle that covers the whole image.
    return vec4<f32>(f32(corner & 1u) * 4.0 - 1.0, f32(corner >> 1u) * 4.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) at: vec4<f32>) -> @location(0) vec4<f32> {
    return textureLoad(source, vec2<i32>(at.xy), 0);
}
