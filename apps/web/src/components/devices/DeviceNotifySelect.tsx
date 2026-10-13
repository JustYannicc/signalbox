/**
 * A client device's own notification setting (All, Quiet badge, Urgent only,
 * Off). One control for the Devices card and Settings › Notifications, both
 * writing `deviceLevelsStore`, so delivery (`levels/delivery.ts`) sees it.
 */
import { useDeviceLevelsStore } from "./deviceLevelsStore";
import {
  DEVICE_NOTIFY_LABEL,
  DEVICE_NOTIFY_LEVELS,
  isDeviceNotifyLevel,
  type ClientDevice,
} from "./devicesModel";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

export function DeviceNotifySelect({
  device,
  variant,
}: {
  readonly device: ClientDevice;
  /** `ghost` on the compact Devices card, the default trigger in settings rows. */
  readonly variant?: "ghost";
}) {
  const setNotify = useDeviceLevelsStore((state) => state.setNotify);
  return (
    <Select
      value={device.notify}
      onValueChange={(next) => {
        if (isDeviceNotifyLevel(next)) setNotify(device.id, next);
      }}
    >
      <SelectTrigger
        aria-label={`Notifications on ${device.name}`}
        size={variant ? "compact" : "sm"}
        variant={variant}
        className={variant ? "w-auto min-w-0" : "w-full sm:w-40"}
      >
        <SelectValue>{DEVICE_NOTIFY_LABEL[device.notify]}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {DEVICE_NOTIFY_LEVELS.map((level) => (
          <SelectItem key={level} value={level}>
            {DEVICE_NOTIFY_LABEL[level]}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
