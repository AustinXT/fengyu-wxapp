import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {ROOT,DAILY_ENV} from './daily-dev-config.mjs';
// 仅由统一部署入口调用，使用开发者工具的既有微信登录。
export async function deployWechat(rc) {
  const cli=process.env.WX_CLI_PATH || '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
  const project=path.join(ROOT,'fengyu-daily');
  const projectConfig=JSON.parse(fs.readFileSync(path.join(project,'project.config.json'),'utf8'));
  if(projectConfig.appid!=='wx4da3e1e9ad861396' || rc.envId!==DAILY_ENV || rc.functions[0].name!=='dailyApiDev')throw Error('日报 AppID/环境/函数校验失败');
  const flags=['--project',project];
  if(process.env.WX_DEVTOOLS_PORT)flags.push('--port',process.env.WX_DEVTOOLS_PORT);
  function run(args){
    const result=spawnSync(cli,[...args,...flags],{cwd:ROOT,encoding:'utf8',timeout:180000,maxBuffer:8*1024*1024});
    if(result.error || result.status!==0 || /(?:\[error\]|✖)/.test(result.stdout+'\n'+result.stderr))throw Error(`微信开发者工具操作失败：${args.slice(0,3).join(' ')}；请检查工具的登录和服务端口`);
    return result.stdout;
  }
  const environments=run(['cloud','env','list']);
  if(!environments.includes(DAILY_ENV))throw Error('开发者工具登录无法访问指定日报环境');
  const before=run(['cloud','functions','info','--env',DAILY_ENV,'--names','dailyApiDev']);
  if(!before.includes('Nodejs18.15'))throw Error('请先在正确的 cloud1 环境中创建 Node.js 18.15 的 dailyApiDev；禁止微信 CLI 使用默认运行版本首次创建。');
  const directory=path.join(ROOT,'_tmp','daily-deploy','dailyApiDev');
  fs.mkdirSync(path.dirname(directory),{recursive:true});
  fs.rmSync(directory,{recursive:true,force:true});
  fs.cpSync(path.join(project,'cloudfunctions','dailyApi'),directory,{recursive:true,filter:src=>!src.split(path.sep).includes('node_modules') && !src.split(path.sep).includes('tests')});
  // 微信 CLI 的 config.json 只处理权限等代码配置，不支持推送运行参数。
  // 环境变量必须由控制台配置；严禁把数据库凭据打进代码包。
  try {
    const report=run(['cloud','functions','deploy','--env',DAILY_ENV,'--paths',directory,'--remote-npm-install','--report']);
    fs.writeFileSync(path.join(ROOT,'_tmp','daily-deploy','upload-report.txt'),report,{mode:0o600});
    const readback=path.join(ROOT,'_tmp','daily-deploy','readback');
    fs.rmSync(readback,{recursive:true,force:true});
    run(['cloud','functions','download','--env',DAILY_ENV,'--name','dailyApiDev','--path',readback]);
    const files=['index.js','routes/auth.js','routes/report.js','utils/phone-auth.js','utils/test-binding.js','utils/permission-matrix.js','utils/report-scope.js','routes/management.js','db/pg.js'];
    if(fs.existsSync(path.join(directory,'utils/test-binding.json')))files.push('utils/test-binding.json');
    for (const file of files) {
      const actual=path.join(readback,file);
      if(!fs.existsSync(actual) || !fs.readFileSync(actual).equals(fs.readFileSync(path.join(directory,file))))throw Error(`云端代码回读不一致：${file}；停止确认部署。`);
    }
    console.log(`dailyApiDev 代码已上传到 ${DAILY_ENV}，云端文件回读一致`);
    const info=run(['cloud','functions','info','--env',DAILY_ENV,'--names','dailyApiDev']);
    fs.writeFileSync(path.join(ROOT,'_tmp','daily-deploy','function-info.txt'),info,{mode:0o600});
    if (!info.includes('Nodejs18.15') || !/\b30\b/.test(info)) {
      throw Error('代码已上传，但运行配置未通过：请在云控制台确认 Nodejs18.15、超时30秒，再核验环境变量；当前部署未完成。');
    }
    throw Error('代码已上传；微信 CLI 无法回读环境变量，仍需控制台核验 PG_CONNECTION_STRING、TZ 和 DEPLOY_CHANNEL，并通过 auth.login 测试后才能确认部署完成。');
  } finally {
    fs.rmSync(directory,{recursive:true,force:true});
  }
}
