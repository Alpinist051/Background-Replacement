#version 300 es
precision highp float;

// Performance: ~0.2ms extra cost; adaptive blend keeps edges stable without long motion trails.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_currentMask;
uniform sampler2D u_previousMask;
uniform float u_currentWeight;
uniform float u_previousWeight;

void main() {
  float current = texture(u_currentMask, v_uv).r;
  float previous = texture(u_previousMask, v_uv).r;

  // Adapt temporal blending to motion: trust current mask more when the edge moves.
  float delta = abs(current - previous);
  float motion = smoothstep(0.06, 0.30, delta);
  float prevW = mix(clamp(u_previousWeight, 0.0, 1.0), 0.05, motion);
  float currW = 1.0 - prevW;

  float result = clamp(current * currW + previous * prevW, 0.0, 1.0);
  outColor = vec4(result, result, result, 1.0);
}
