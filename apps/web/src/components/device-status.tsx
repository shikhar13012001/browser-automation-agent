"use client";

import { Badge } from "@/components/ui/badge";
import type { Device } from "@/lib/store";

export function DeviceStatus({ devices, now }: { devices: Device[]; now: number }) {
  const isOnline = (d: Device) => now - new Date(d.lastSeenAt).getTime() < 10_000;

  if (devices.length === 0) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        No device connected -- start the daemon
      </Badge>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {devices.map((d) => (
        <Badge key={d.id} variant={isOnline(d) ? "default" : "secondary"} className="gap-1.5">
          <span className={`h-1.5 w-1.5 rounded-full ${isOnline(d) ? "bg-green-400" : "bg-muted-foreground"}`} />
          {d.id}
        </Badge>
      ))}
    </div>
  );
}
