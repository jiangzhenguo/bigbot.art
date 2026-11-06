'use strict';

const { copyFileSync, existsSync, readFileSync, statSync } = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');

/**
 * 姿势选择示例的执行器。
 *
 * 插件本身不生成图像：它把检查器里选中的姿势对应缩略图复制成「参考图」产物，
 * 用来演示「可视化选择 → 参数写回 → 执行器读取参数」这条完整链路。
 */
async function execute(ctx) {
  const poseId = ctx.parameters.pose;
  if (typeof poseId !== 'string' || !poseId) {
    throw new Error('请先在检查器的姿势选择器里选择一个姿势');
  }

  const catalogPath = join(__dirname, '..', 'catalog', 'poses.json');
  if (!existsSync(catalogPath)) throw new Error(`姿势清单缺失: ${catalogPath}`);

  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  } catch (error) {
    throw new Error(`姿势清单不是合法 JSON: ${error.message}`);
  }
  const items = Array.isArray(catalog?.items) ? catalog.items : [];
  const item = items.find((row) => row && row.id === poseId);
  if (!item) throw new Error(`姿势清单里没有 ${poseId}`);

  const source = resolve(dirname(catalogPath), String(item.thumb ?? ''));
  if (!item.thumb || !existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`姿势 ${poseId} 的参考图缺失`);
  }

  const resultPath = join(ctx.outputDir, `${poseId}.png`);
  copyFileSync(source, resultPath);

  ctx.log(`已导出姿势参考图: ${poseId}${ctx.parameters.angle ? ` · ${ctx.parameters.angle}` : ''}`);
  ctx.reportProgress(100, '姿势参考图已生成');

  return {
    resultPath: basename(resultPath),
    data: { pose: poseId, angle: ctx.parameters.angle ?? null },
  };
}

module.exports = { execute };
