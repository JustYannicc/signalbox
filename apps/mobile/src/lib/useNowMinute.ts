import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useState } from "react";
import { AppState } from "react-native";

export function useNowMinute(): number {
  const [now, setNow] = useState(Date.now);
  useFocusEffect(
    useCallback(() => {
      const updateNow = () => setNow(Date.now());
      updateNow();
      const timer = setInterval(updateNow, 60_000);
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") updateNow();
      });
      return () => {
        clearInterval(timer);
        subscription.remove();
      };
    }, []),
  );
  return now;
}
