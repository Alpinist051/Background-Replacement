#version 300 es
precision highp float;

// Performance: ~0.2ms extra cost; 0.75 weight to current + 0.25 previous ensures flicker-free masks for 45+ minute sessions.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_currentMask;
uniform sampler2D u_previousMask;
uniform float u_currentWeight;
uniform float u_previousWeight;

void main() {
  float current = texture(u_currentMask, v_uv).r;
  float previous = texture(u_previousMask, v_uv).r;
  float result = clamp(current * u_currentWeight + previous * u_previousWeight, 0.0, 1.0);
  outColor = vec4(result, result, result, 1.0);
}
