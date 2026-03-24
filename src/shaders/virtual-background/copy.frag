#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_tex;
uniform float u_flipY; // 1.0 to flip vertically

void main() {
  vec2 uv = v_uv;
  if (u_flipY > 0.5) {
    uv.y = 1.0 - uv.y;
  }
  outColor = texture(u_tex, uv);
}

