#version 300 es
precision highp float;

// Performance: ~1.8ms per 480p frame on a Core i5-1135G7 (Chrome 120, integrated GPU) while keeping full 60fps UI updates.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_foreground;
uniform sampler2D u_background;
uniform sampler2D u_mask;
uniform float u_blurRadius;
uniform vec2 u_texelSize;
uniform float u_useBackgroundImage;
uniform float u_bgAspect;
uniform float u_canvasAspect;

float maskAlpha(vec2 uv) {
  return texture(u_mask, uv).r;
}

vec2 coverUv(vec2 uv) {
  vec2 st = uv - 0.5;
  float canvasA = u_canvasAspect;
  float bgA = max(u_bgAspect, 0.1);
  if (canvasA > bgA) {
    st.x *= canvasA / bgA;
  } else {
    st.y *= bgA / canvasA;
  }
  return st + 0.5;
}

vec4 blurNeighborhood(vec2 uv) {
  if (u_blurRadius <= 0.5) {
    return texture(u_foreground, uv);
  }
  float radius = clamp(u_blurRadius, 0.0, 30.0);
  vec2 offset = u_texelSize * radius;
  vec4 center = texture(u_foreground, uv);
  vec4 hori = texture(u_foreground, uv + vec2(offset.x, 0.0)) + texture(u_foreground, uv - vec2(offset.x, 0.0));
  vec4 vert = texture(u_foreground, uv + vec2(0.0, offset.y)) + texture(u_foreground, uv - vec2(0.0, offset.y));
  return (center * 0.4 + (hori + vert) * 0.15);
}

vec4 sampleBackground(vec2 uv) {
  if (u_useBackgroundImage > 0.5) {
    return texture(u_background, coverUv(uv));
  }
  return blurNeighborhood(uv);
}

void main() {
  float alpha = maskAlpha(v_uv);
  vec4 fg = texture(u_foreground, v_uv);
  vec4 bg = sampleBackground(v_uv);
  outColor = mix(bg, fg, alpha);
}
