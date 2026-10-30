import {defineConfig} from 'vitest/config';
import {companionFixtureBudget} from '../../tests/support/sshFixture';

export default defineConfig({test:{
  include:['published-native-e2e/**/*.test.ts'],environment:'node',fileParallelism:false,maxWorkers:1,
  testTimeout:companionFixtureBudget,hookTimeout:30_000,retry:0,silent:false,
}});
