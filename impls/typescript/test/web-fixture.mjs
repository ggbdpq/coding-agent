// 公共 Web 壳测试宿主：真实装配，只把外部模型端点和数据目录换成测试输入。
import path from 'node:path';
import { createApp } from '../src/kernel/app.ts';
import { Registry } from '../src/kernel/registry.ts';
import { builtinPlugins } from '../src/plugins/index.ts';
import { SessionStore } from '../src/core/session.ts';
import { startWeb } from '../src/shell/web.ts';

process.chdir(process.env.TCODE_TEST_WORKSPACE);
const config = {
  apiKey: 'test-key', baseUrl: process.env.TCODE_TEST_PROVIDER, model: 'fake-model',
  contextLimit: 100000, tcodeDir: process.env.TCODE_DATA_DIR,
};
const app = createApp(config, new Registry().registerAll(builtinPlugins), {
  yolo: false,
  freshMessages: () => [{ role: 'system', content: '测试宿主' }],
  store: new SessionStore(path.join(config.tcodeDir, 'sessions')),
});
await startWeb(app);
