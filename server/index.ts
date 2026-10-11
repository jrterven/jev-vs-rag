import { readConfig } from './config.js';
import { createEngines } from './engines/index.js';
import { buildApp } from './app.js';
const config=readConfig();
const {app}=await buildApp(config,createEngines(config));
try {await app.listen({port:config.port,host:'127.0.0.1'});console.log(`API: http://127.0.0.1:${config.port}`);}
catch(error){console.error(error instanceof Error?error.message:'No se pudo iniciar el servidor.');process.exitCode=1;}
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
