#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_foreground;
uniform sampler2D u_background;
uniform sampler2D u_maskTex;

uniform vec2 u_maskInvSize;
uniform float u_bgAspect;
uniform float u_canvasAspect;
uniform float u_flipY;

float computeMaskAlpha(vec2 uv) {
  float c = texture(u_maskTex, uv).r;
  float l = texture(u_maskTex, uv + vec2(-u_maskInvSize.x, 0.0)).r;
  float r = texture(u_maskTex, uv + vec2(u_maskInvSize.x, 0.0)).r;
  float u = texture(u_maskTex, uv + vec2(0.0, -u_maskInvSize.y)).r;
  float d = texture(u_maskTex, uv + vec2(0.0, u_maskInvSize.y)).r;
  float a = max(c, max(l, max(r, max(u, d))));
  return smoothstep(0.12, 0.85, a);
}

vec2 coverUv(vec2 uv) {
  // Map background image into output canvas using "cover" behavior.
  float canvasA = u_canvasAspect;
  float bgA = u_bgAspect;
  vec2 st = uv - 0.5;
  if (canvasA > bgA) {
    st.x *= canvasA / bgA;
  } else {
    st.y *= bgA / canvasA;
  }
  return st + 0.5;
}

void main() {
  vec2 uv = v_uv;
  if (u_flipY > 0.5) {
    uv.y = 1.0 - uv.y;
  }

  float alpha = computeMaskAlpha(uv);
  vec4 fg = texture(u_foreground, uv);

  vec2 bgUv = coverUv(uv);
  vec4 bg = texture(u_background, bgUv);

  outColor = mix(bg, fg, alpha);
}

