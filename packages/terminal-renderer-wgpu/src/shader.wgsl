// One instanced quad per draw of the shared layout: a solid rectangle or a glyph mask from the atlas.
struct Globals {
    surface: vec2<f32>,
    pad: vec2<f32>,
}

struct Instance {
    @location(0) rect: vec4<u32>,   // x, y, width, height in target pixels
    @location(1) color: u32,        // 0xAABBGGRR
    @location(2) mask: vec2<u32>,   // atlas origin, or 0xffffffff for a solid rectangle
    @location(3) kind: u32,         // 0: coverage mask tinted with color; 1: RGBA glyph from the color atlas
}

struct Varying {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) color: vec4<f32>,
    @location(1) @interpolate(flat) origin: vec2<u32>,
    @location(2) @interpolate(flat) mask: vec2<u32>,
    @location(3) @interpolate(flat) kind: u32,
}

@group(0) @binding(0) var<uniform> globals: Globals;
@group(0) @binding(1) var atlas: texture_2d<f32>;
@group(0) @binding(2) var color_atlas: texture_2d<f32>;

@vertex
fn vs_main(@builtin(vertex_index) corner: u32, inst: Instance) -> Varying {
    let unit = vec2<f32>(f32(corner & 1u), f32(corner >> 1u));
    let pixel = vec2<f32>(inst.rect.xy) + unit * vec2<f32>(inst.rect.zw);
    var out: Varying;
    out.position = vec4<f32>(pixel.x / globals.surface.x * 2.0 - 1.0, 1.0 - pixel.y / globals.surface.y * 2.0, 0.0, 1.0);
    out.color = vec4<f32>(
        f32(inst.color & 0xffu),
        f32((inst.color >> 8u) & 0xffu),
        f32((inst.color >> 16u) & 0xffu),
        255.0,
    ) / 255.0;
    out.origin = inst.rect.xy;
    out.mask = inst.mask;
    out.kind = inst.kind;
    return out;
}

@fragment
fn fs_main(in: Varying) -> @location(0) vec4<f32> {
    var coverage = 1.0;
    if in.mask.x != 0xffffffffu {
        let local = vec2<u32>(in.position.xy) - in.origin;
        if in.kind == 1u {
            let glyph = textureLoad(color_atlas, vec2<i32>(in.mask + local), 0);
            if glyph.a <= 0.0 {
                discard;
            }
            return glyph;
        }
        coverage = textureLoad(atlas, vec2<i32>(in.mask + local), 0).r;
        if coverage <= 0.0 {
            discard;
        }
    }
    return vec4<f32>(in.color.rgb, coverage);
}
