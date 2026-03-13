"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"

function PlaceholderContent({ title }: { title: string }) {
  return (
    <Card>
      <CardContent className="p-12 text-center">
        <div className="flex justify-center mb-4">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#CCCCCC" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="21" x2="9" y2="9" />
          </svg>
        </div>
        <h3 className="text-lg font-semibold text-[#999999]">{title}</h3>
        <p className="text-sm text-[#CCCCCC] mt-2">敬请期待</p>
      </CardContent>
    </Card>
  )
}

export default function DataCenterPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-[var(--foreground)]">数据中心</h1>
      <p className="text-sm text-[#999999]">P2 阶段功能，数据可视化与经营分析</p>

      <Tabs defaultValue="return-rate">
        <TabsList>
          <TabsTrigger value="return-rate">客户回店率</TabsTrigger>
          <TabsTrigger value="category-ratio">品项占比</TabsTrigger>
          <TabsTrigger value="flow">经营动线</TabsTrigger>
          <TabsTrigger value="efficiency">人效分析</TabsTrigger>
          <TabsTrigger value="ranking">排行榜</TabsTrigger>
        </TabsList>

        <TabsContent value="return-rate">
          <PlaceholderContent title="客户回店率分析" />
        </TabsContent>

        <TabsContent value="category-ratio">
          <PlaceholderContent title="品项占比分析" />
        </TabsContent>

        <TabsContent value="flow">
          <PlaceholderContent title="经营动线分析" />
        </TabsContent>

        <TabsContent value="efficiency">
          <PlaceholderContent title="人效分析" />
        </TabsContent>

        <TabsContent value="ranking">
          <PlaceholderContent title="排行榜" />
        </TabsContent>
      </Tabs>
    </div>
  )
}
