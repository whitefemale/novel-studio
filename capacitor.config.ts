import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Android 打包配置。
 *
 * 构建步骤：
 *   npm run build
 *   npx cap sync android
 *   cd android && ./gradlew assembleDebug   →  .../apk/debug/app-debug.apk
 *   cd android && ./gradlew assembleRelease →  .../apk/release/app-release.apk（需签名材料）
 *
 * 工具链版本锁定（Capacitor 8.5.1 的要求，见 CLAUDE.md）：
 *   JDK 21 · Gradle 8.14.3 · AGP 8.13.0 · compileSdk/targetSdk 36 · minSdk 24
 *
 * 明文 http：debug 与 release 都允许。release 侧由
 * android/app/src/main/res/xml/network_security_config.xml 的
 * cleartextTrafficPermitted="true" 放行（Android 9+ 默认禁止明文）。
 * 这是有意的放宽——局域网同步、本机 Ollama、内网 LLM 端点都可能是 http://；
 * 代价是同一网络里的其他人可能看到请求内容（含 API Key），公网服务请用 https。
 */
const config: CapacitorConfig = {
  appId: 'com.novelstudio.app',
  appName: 'Novel Studio',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // 用户可以把 LLM 端点配成内网的 http 地址
    cleartext: true
  },
  android: {
    allowMixedContent: true
  }
}

export default config
