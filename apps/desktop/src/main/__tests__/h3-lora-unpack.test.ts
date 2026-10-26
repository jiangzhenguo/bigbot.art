/**
 * 真实 merge_lora_h3.py 小权重回归（不加载大模型）。
 *
 * t8star turbo LoRA 除 blocks.N 外还含 9 组 final_layer / token_refiner 权重。
 * 这里同时覆盖 ComfyUI 与 sd-scripts 两种命名，验证它们都被识别并真正写回 BF16 shard。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const MERGE_SCRIPT = join(homedir(), 'ai', 'h3', 'merge_lora_h3.py');
const tmp = mkdtempSync(join(tmpdir(), 'bbart-h3-lora-unpack-'));

const TARGETS = [
  { h3: 'blocks.0.attn.qkv_proj.weight', comfy: 'blocks.0.attn.qkv_proj', sd: 'blocks_0_attn_qkv_proj' },
  { h3: 'token_refiner.blocks.0.mlp.fc1.weight', comfy: 'token_refiner.blocks.0.mlp.fc1', sd: 'token_refiner_blocks_0_mlp_fc1' },
  { h3: 'final_layer.adaln_proj.linear.weight', comfy: 'final_layer.adaln_proj.linear', sd: 'final_layer_adaln_proj_linear' },
] as const;

type Tensor = { name: string; dtype: 'F32' | 'BF16'; shape: number[]; values: number[] };

function bf16Bits(value: number): number {
  const b = Buffer.alloc(4);
  b.writeFloatLE(value, 0);
  const u = b.readUInt32LE(0);
  return ((u + 0x7fff + ((u >>> 16) & 1)) >>> 16) & 0xffff;
}

function bf16ToFloat(bits: number): number {
  const b = Buffer.alloc(4);
  b.writeUInt32LE((bits * 65536) >>> 0, 0);
  return b.readFloatLE(0);
}

function writeSafetensors(path: string, tensors: Tensor[]): void {
  const header: Record<string, { dtype: string; shape: number[]; data_offsets: number[] }> = {};
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const tensor of tensors) {
    const itemSize = tensor.dtype === 'F32' ? 4 : 2;
    const bytes = Buffer.alloc(tensor.values.length * itemSize);
    tensor.values.forEach((value, index) => {
      if (tensor.dtype === 'F32') bytes.writeFloatLE(value, index * 4);
      else bytes.writeUInt16LE(bf16Bits(value), index * 2);
    });
    header[tensor.name] = { dtype: tensor.dtype, shape: tensor.shape, data_offsets: [offset, offset + bytes.length] };
    chunks.push(bytes);
    offset += bytes.length;
  }
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const padding = Buffer.alloc((8 - (json.length % 8)) % 8, 0x20);
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(json.length + padding.length), 0);
  writeFileSync(path, Buffer.concat([size, json, padding, ...chunks]));
}

function readBf16Tensor(path: string, key: string): number[] {
  const file = readFileSync(path);
  const hlen = Number(file.readBigUInt64LE(0));
  const header = JSON.parse(file.subarray(8, 8 + hlen).toString('utf8'));
  const info = header[key] as { data_offsets: [number, number] } | undefined;
  expect(info, `missing output tensor ${key}`).toBeDefined();
  const [start, end] = info!.data_offsets;
  const out: number[] = [];
  for (let offset = 8 + hlen + start; offset < 8 + hlen + end; offset += 2) {
    out.push(bf16ToFloat(file.readUInt16LE(offset)));
  }
  return out;
}

function runCase(style: 'comfy' | 'sd'): void {
  const base = join(tmp, `base-${style}`);
  const out = join(tmp, `out-${style}`);
  const lora = join(tmp, `${style}.safetensors`);
  mkdirSync(base, { recursive: true });
  const baseTensors: Tensor[] = TARGETS.map((target) => ({
    name: target.h3,
    dtype: 'BF16',
    shape: [2, 2],
    values: [1, 1, 1, 1],
  }));
  writeSafetensors(join(base, 'model.safetensors'), baseTensors);
  writeFileSync(join(base, 'config.json'), '{"fixture":true}');

  const loraTensors: Tensor[] = [];
  for (const target of TARGETS) {
    if (style === 'comfy') {
      loraTensors.push(
        { name: `diffusion_model.${target.comfy}.lora_A.weight`, dtype: 'F32', shape: [1, 2], values: [0.1, 0.2] },
        { name: `diffusion_model.${target.comfy}.lora_B.weight`, dtype: 'F32', shape: [2, 1], values: [0.3, 0.4] },
      );
    } else {
      loraTensors.push(
        { name: `lora_unet_${target.sd}.lora_down.weight`, dtype: 'F32', shape: [1, 2], values: [0.1, 0.2] },
        { name: `lora_unet_${target.sd}.lora_up.weight`, dtype: 'F32', shape: [2, 1], values: [0.3, 0.4] },
        { name: `lora_unet_${target.sd}.alpha`, dtype: 'F32', shape: [1], values: [1] },
      );
    }
  }
  writeSafetensors(lora, loraTensors);

  const run = spawnSync(
    'python3',
    [MERGE_SCRIPT, '--lora', lora, '--src', base, '--dst', out, '--strength', '1.0'],
    { encoding: 'utf8', timeout: 30000 },
  );
  expect(run.status, `${run.stdout}\n${run.stderr}`).toBe(0);
  expect(run.stdout).toContain('lora targets: 3 tensors');
  expect(run.stdout).toContain('DONE. applied 3/3 lora tensors');
  expect(JSON.parse(readFileSync(join(out, 'config.json'), 'utf8'))).toEqual({ fixture: true });
  for (const target of TARGETS) {
    const actual = readBf16Tensor(join(out, 'model.safetensors'), target.h3);
    // B@A = [[.03,.06],[.04,.08]]; BF16 基值全为 1。
    expect(actual).toHaveLength(4);
    [1.03, 1.06, 1.04, 1.08].forEach((expected, index) => {
      expect(actual[index], `${target.h3}[${index}]`).toBeCloseTo(expected, 2);
    });
  }
}

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('merge_lora_h3.py · final_layer / token_refiner 解包', () => {
  it('ComfyUI 命名：blocks + token_refiner + final_layer 全部写入 shard', () => {
    expect(existsSync(MERGE_SCRIPT)).toBe(true);
    runCase('comfy');
  });

  it('sd-scripts 命名：特殊命名空间也映射到正确 h3 键', () => {
    runCase('sd');
  });
});
