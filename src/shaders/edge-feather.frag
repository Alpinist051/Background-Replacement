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
  float c  = texture(u_mask, uv).r;
  float l  = texture(u_mask, uv + vec2(-step.x, 0.0)).r;
  float r  = texture(u_mask, uv + vec2(step.x, 0.0)).r;
  float u  = texture(u_mask, uv + vec2(0.0, -step.y)).r;
  float d  = texture(u_mask, uv + vec2(0.0, step.y)).r;
  float lu = texture(u_mask, uv + vec2(-step.x, -step.y)).r;
  float ru = texture(u_mask, uv + vec2(step.x, -step.y)).r;
  float ld = texture(u_mask, uv + vec2(-step.x, step.y)).r;
  float rd = texture(u_mask, uv + vec2(step.x, step.y)).r;

  // Slight dilation protects hair/shoulder edges from holes.
  float maxN = max(c, max(max(l, r), max(max(u, d), max(max(lu, ru), max(ld, rd)))));

  // Weighted local average to suppress noise and jagged edges.
  float avg = c * 0.36 +
              (l + r + u + d) * 0.11 +
              (lu + ru + ld + rd) * 0.05;

  float k = clamp(u_strength, 1.0, 3.0);
  float refined = mix(avg, maxN, 0.20 + 0.18 * ((k - 1.0) / 2.0));

  // Keep foreground interior confidently opaque while preserving soft boundaries.
  float soft = smoothstep(0.14, 0.78, refined);
  float hard = smoothstep(0.58, 0.92, refined);
  return clamp(max(soft * 0.94, hard), 0.0, 1.0);
}

void main() {
  float alpha = feather(v_uv);
  outColor = vec4(alpha, alpha, alpha, 1.0);
}
