/**
 * 应用版本号。
 *
 * Vite 构建时通过 `define` 注入 `__APP_VERSION__`（唯一事实来源是
 * package.json 的 version）。单元测试直接 import 本文件时没有这个全局变量，
 * `typeof` 检查让它在 Node 里安全地回落到 'dev'，不必为了跑测试去造一个全局。
 *
 * 它只用于快照头与界面展示，**不参与任何业务判断** —— 协议兼容性看的是
 * SNAPSHOT_VERSION 与 SCHEMA_VERSION，两者语义完全不同。
 */
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
