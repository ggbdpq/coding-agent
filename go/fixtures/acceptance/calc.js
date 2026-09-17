// 玩具计算器：gcode 验收夹具。mod 的实现有 bug（JS 的 % 对负数返回负余数，未做规范化）。
export function add(a, b) {
  return a + b;
}

export function sub(a, b) {
  return a - b;
}

export function mul(a, b) {
  return a * b;
}

export function mod(a, b) {
  return a % b;
}
