import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({
  plugins: [vue()], optimizeDeps: { entries: ['index.html'] },
  server: {
    watch: { ignored: ['**/work/**','**/backups/**','**/artifacts/**','**/.tools/**','**/.npm-cache/**','**/server-data/**'] },
    fs: { deny: ['.env*','**/.git/**','**/server-data/**','**/work/**','**/backups/**'] }
  }
});
