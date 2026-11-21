import type { ProjectStatsSummary } from "@authfleet/core";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "~/components/ui/card";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "~/components/ui/chart";
import { growthDescription, signupChartData, snapshotChartData } from "~/lib/dashboard-data";

const totalUsersChartConfig = {
  total: { label: "Total users", color: "var(--chart-1)" },
} satisfies ChartConfig;

const signupsChartConfig = {
  count: { label: "Signups", color: "var(--chart-2)" },
} satisfies ChartConfig;

export function TotalUsersChartCard({ summary }: { summary: ProjectStatsSummary }) {
  const growth = summary.growth;
  const snapshotData = snapshotChartData(summary);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Total users</CardTitle>
        <CardDescription>{growthDescription(growth)}</CardDescription>
      </CardHeader>
      {growth ? (
        <CardContent>
          <ChartContainer config={totalUsersChartConfig} className="aspect-auto h-[280px] w-full">
            <AreaChart accessibilityLayer data={snapshotData} margin={{ left: 4, right: 12 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={32}
                tickFormatter={(value: string) => value.slice(5)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={52}
                tickFormatter={(value: number) => value.toLocaleString()}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
              <defs>
                <linearGradient id="fillTotalUsers" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--color-total)" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="var(--color-total)" stopOpacity={0.1} />
                </linearGradient>
              </defs>
              <Area
                dataKey="total"
                type="natural"
                fill="url(#fillTotalUsers)"
                stroke="var(--color-total)"
                strokeWidth={2}
                isAnimationActive={false}
              />
            </AreaChart>
          </ChartContainer>
        </CardContent>
      ) : null}
    </Card>
  );
}

export function DailySignupsChartCard({ summary }: { summary: ProjectStatsSummary }) {
  const signupData = signupChartData(summary);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Signups per day</CardTitle>
        <CardDescription>Last 30 days</CardDescription>
      </CardHeader>
      <CardContent>
        {signupData.length > 0 ? (
          <ChartContainer config={signupsChartConfig} className="aspect-auto h-[280px] w-full">
            <BarChart accessibilityLayer data={signupData} margin={{ left: 4, right: 12 }}>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="date"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                minTickGap={24}
                tickFormatter={(value: string) => value.slice(5)}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                width={36}
                allowDecimals={false}
              />
              <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
              <Bar
                dataKey="count"
                fill="var(--color-count)"
                radius={[4, 4, 0, 0]}
                isAnimationActive={false}
              />
            </BarChart>
          </ChartContainer>
        ) : (
          <p className="text-sm text-muted-foreground">No signup data available.</p>
        )}
      </CardContent>
    </Card>
  );
}
