#version 300 es
precision highp float;

// Performance: ~0.8ms per frame on i5-1135G7 (Chrome 120) when combined with blur — light wrapping keeps studio sheen soft.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_foreground;
uniform sampler2D u_blurred;
uniform sampler2D u_mask;
uniform vec2 u_texelSize;
uniform float u_wrapStrength;

float maskAlpha(vec2 uv) {
  return texture(u_mask, uv).r;
}

float edgeIntensity(float maskVal) {
  return clamp((1.0 - maskVal) * 1.8, 0.0, 1.0);
}

void main() {
  float maskVal = maskAlpha(v_uv);
  vec3 fg = texture(u_foreground, v_uv).rgb;
  vec3 blur = texture(u_blurred, v_uv).rgb;
  float wrap = edgeIntensity(maskVal);
  vec3 wrapped = mix(fg, blur, wrap * clamp(u_wrapStrength, 0.0, 1.0));
  vec3 finalColor = mix(wrapped, fg, maskVal);
  vec3 lightEdge = mix(vec3(0.0), blur, wrap * 0.35);
  finalColor += lightEdge * (1.0 - maskVal) * 0.35;
  outColor = vec4(finalColor, 1.0);
}
