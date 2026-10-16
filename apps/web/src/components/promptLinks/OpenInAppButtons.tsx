import { Button } from "../ui/button";

/** Where people get the Signalbox app. */
const SIGNALBOX_DOWNLOAD_URL = "https://github.com/JustYannicc/signalbox/releases/latest";

/** Opens `deepLink` in the installed app: the phone app on a phone, else the desktop app. */
export function OpenInAppButton(props: {
  readonly deepLink: string;
  readonly onClick?: () => void;
}) {
  const onPhone = /android|iphone|ipad/i.test(navigator.userAgent);
  return (
    <Button
      render={<a href={props.deepLink} />}
      {...(props.onClick ? { onClick: props.onClick } : {})}
    >
      {onPhone ? "Open in app" : "Open in desktop app"}
    </Button>
  );
}

/** For people who don't have the app yet. `newTab` keeps the page they're on. */
export function GetSignalboxButton(props: { readonly newTab?: boolean }) {
  return (
    <Button
      variant="ghost"
      render={
        props.newTab ? (
          <a href={SIGNALBOX_DOWNLOAD_URL} target="_blank" rel="noreferrer" />
        ) : (
          <a href={SIGNALBOX_DOWNLOAD_URL} />
        )
      }
    >
      Get Signalbox
    </Button>
  );
}
