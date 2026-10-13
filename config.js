// Safe to expose client-side — this is the publishable (anon) key, not the secret key.
window.UNBROKEN_CONFIG = {
  supabaseUrl: "https://vapznekmobryxjkqodgu.supabase.co",
  supabasePublishableKey: "sb_publishable_yfD1zbMMrpyBS8wG9tc6nw_vXGzFepj",
  revenueCatIosKey: "appl_hlWqRRzFAKHAlKWTthUwEQZnfDt",
  revenueCatAndroidKey: "goog_nakJiAXiEzZvuFhcSMdWUJGMkZM",
  // iPhone purchases stay off until Apple's Paid Apps Agreement is active.
  // While false, iPhone shows "Coming soon" instead of the Unlock button. Set to true, push, and resubmit to turn sales on.
  iosPurchasesEnabled: false
};
