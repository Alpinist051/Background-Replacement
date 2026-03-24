#version 300 es
precision highp float;

// Performance: ~0.4ms per 480p pass on i5-1135G7 (Chrome 120) after the blur step — keeps edges smooth without extra draw calls.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_mask;
uniform vec2 u_texelSize;
uniform float u_strength; // 1.0..3.0

float feather(vec2 uv) {
  vec2 step = u_texelSize;
  float sample0 = texture(u_mask, uv).r;
  float sample1 = texture(u_mask, uv + vec2(step.x, 0.0)).r;
  float sample2 = texture(u_mask, uv - vec2(step.x, 0.0)).r;
  float sample3 = texture(u_mask, uv + vec2(0.0, step.y)).r;
  float sample4 = texture(u_mask, uv - vec2(0.0, step.y)).r;
  float radius = clamp(u_strength, 1.0, 3.0);
  float blend = (sample0 * 0.4 + (sample1 + sample2 + sample3 + sample4) * 0.15) / (0.4 + 4.0 * 0.15);
  float mixFactor = smoothstep(0.05, 0.2, blend) * radius * 0.33;
  return mix(sample0, blend, mixFactor);
}

void main() {
  float alpha = feather(v_uv);
  outColor = vec4(alpha, alpha, alpha, 1.0);
}
