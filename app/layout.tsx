import type { Metadata } from 'next'
import './globals.css'
export const metadata:Metadata={title:'Bandroom · IELTS 练习室',description:'从上次停下的地方，接续你的雅思训练。',icons:{icon:'/favicon.svg'}}
export default function Layout({children}:{children:React.ReactNode}){return <html lang="zh-CN"><body>{children}</body></html>}
