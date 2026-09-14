import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Android 打包配置。
 *
 * 构建步骤：
 *   npm run build
 *   npx cap sync android
 *   cd android && ./gradlew assembleDebug   →  android/app/build/outputs/apk/debug/app-debug.apk
 *
 * 工具链版本锁定（Capacitor 8.5.1 的要求，见 CLAUDE.md）：
 *   JDK 21 · Gradle 8.14.3 · AGP 8.13.0 · compileSdk/targetSdk 36 · minSdk 24
 *
 * 注意：本次只出 debug APK。发布版若要支持明文 http 的 LLM 端点，
 * 还需要额外配置 Android 的 networkSecurityConfig，此处未做。
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
