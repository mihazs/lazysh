import {defineConfig} from 'vitest/config';

export default defineConfig({test:{
  include:['native-e2e/**/*.spec.ts'],environment:'node',fileParallelism:false,maxWorkers:1,
  testTimeout:120_000,hookTimeout:30_000,retry:0,silent:false,
}});
