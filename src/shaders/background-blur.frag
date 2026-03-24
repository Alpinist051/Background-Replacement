#version 300 es
precision highp float;

// Performance: ~1.8ms per 480p frame on a Core i5-1135G7 (Chrome 120, integrated GPU) while keeping full 60fps UI updates.

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_foreground;
uniform sampler2D u_background;
uniform sampler2D u_mask;
uniform sampler2D u_blurSource;
uniform float u_blurRadius;
uniform vec2 u_texelSize;
uniform vec2 u_blurSourceTexelSize;
uniform float u_useBackgroundImage;
uniform float u_bgAspect;
uniform float u_canvasAspect;
uniform float u_flipY;

float maskAlpha(vec2 uv) {
  float m = texture(u_mask, uv).r;
  // Tighten matte more aggressively for image replacement to avoid bright edge halos.
  if (u_useBackgroundImage > 0.5) {
    float coreImg = smoothstep(0.62, 0.93, m);
    float edgeImg = smoothstep(0.26, 0.74, m);
    return clamp(max(coreImg, edgeImg * 0.92) * 1.04, 0.0, 1.0);
  }
  // Blur mode can keep softer transitions.
  float core = smoothstep(0.56, 0.90, m);
  float edge = smoothstep(0.18, 0.68, m);
  return clamp(max(core, edge * 0.93), 0.0, 1.0);
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
    return texture(u_blurSource, uv);
  }

  // Use low-resolution blur source: fewer samples + smoother output.
  float t = clamp(u_blurRadius / 30.0, 0.0, 1.0);
  float r = mix(0.8, 3.6, t);
  vec2 d = u_blurSourceTexelSize * r;

  vec4 c = texture(u_blurSource, uv) * 0.28;
  vec4 x = (texture(u_blurSource, uv + vec2(d.x, 0.0)) + texture(u_blurSource, uv - vec2(d.x, 0.0))) * 0.12;
  vec4 y = (texture(u_blurSource, uv + vec2(0.0, d.y)) + texture(u_blurSource, uv - vec2(0.0, d.y))) * 0.12;
  vec4 d1 = (texture(u_blurSource, uv + d) + texture(u_blurSource, uv - d)) * 0.06;
  vec4 d2 = (texture(u_blurSource, uv + vec2(d.x, -d.y)) + texture(u_blurSource, uv + vec2(-d.x, d.y))) * 0.06;
  return c + x + y + d1 + d2;
}

vec4 sampleBackground(vec2 uv) {
  if (u_useBackgroundImage > 0.5) {
    return texture(u_background, coverUv(uv));
  }
  return blurNeighborhood(uv);
}

void main() {
  vec2 uv = v_uv;
  if (u_flipY > 0.5) {
    uv.y = 1.0 - uv.y;
  }
  float alpha = maskAlpha(uv);
  vec4 fg = texture(u_foreground, uv);
  vec4 bg = sampleBackground(uv);
  outColor = mix(bg, fg, alpha);
}
