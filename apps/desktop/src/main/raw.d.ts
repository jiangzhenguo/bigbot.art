/** Vite `?raw` 导入声明:内置技能 Markdown 以纯文本打进 main 包 */
declare module '*.md?raw' {
  const content: string;
  export default content;
}
