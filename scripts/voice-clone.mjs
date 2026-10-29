import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { queryVoice, trainVoice } from '../src/voice-clone.js';

try {
  const { positionals, values } = parseArgs({ allowPositionals: true,
    options: { config: { type: 'string' }, audio: { type: 'string' } } });
  const action = positionals[0];
  if (!['status', 'train'].includes(action) || positionals.length !== 1 || !values.config || (action === 'train' && !values.audio)) {
    throw new Error('用法：node scripts/voice-clone.mjs status|train --config 私有配置.json [--audio 已筛选对白.wav]');
  }
  const config = JSON.parse(fs.readFileSync(values.config, 'utf8'));
  const result = action === 'train' ? await trainVoice(config, values.audio) : await queryVoice(config);
  console.log(JSON.stringify({ speaker: result.speaker_id, status: result.status,
    availableTrainingTimes: result.available_training_times,
    hasDemo: !!result.speaker_status?.some(s => s.demo_audio),
    hint: '状态2或4表示可合成；训练结果仍须试听确认。未切换机器人音色。' }, null, 2));
  if (result.status === 3) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
