package com.vag11.tv;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONException;
import org.json.JSONObject;

/** SponsorBlock and ad-blocking choices, kept on the TV only. */
final class Prefs {
    static final int AUTO = 0;
    static final int ASK = 1;
    static final int OFF = 2;
    static final String[] MODE_NAMES = {"Auto skip", "Show a skip button", "Off"};

    static final String[] CATS = {
            "sponsor", "selfpromo", "interaction", "intro", "outro", "preview", "music_offtopic", "filler"
    };
    static final String[] CAT_NAMES = {
            "Sponsor", "Unpaid / self promotion", "Interaction reminder (subscribe)", "Intro",
            "Endcards / credits", "Preview / recap", "Non-music section", "Filler / tangent"
    };

    private final SharedPreferences sp;

    Prefs(Context c) {
        sp = c.getSharedPreferences("sponsorblock", Context.MODE_PRIVATE);
    }

    boolean enabled() {
        return sp.getBoolean("enabled", true);
    }

    void setEnabled(boolean on) {
        sp.edit().putBoolean("enabled", on).apply();
    }

    boolean adBlock() {
        return sp.getBoolean("adblock", true);
    }

    void setAdBlock(boolean on) {
        sp.edit().putBoolean("adblock", on).apply();
    }

    int mode(String cat) {
        return sp.getInt("cat_" + cat, "sponsor".equals(cat) ? AUTO : OFF);
    }

    void setMode(String cat, int mode) {
        sp.edit().putInt("cat_" + cat, mode).apply();
    }

    /** The shape the page scripts read: {"enabled":true,"cats":{"sponsor":0,...},"adblock":true}. */
    String json() {
        try {
            JSONObject cats = new JSONObject();
            for (String c : CATS) cats.put(c, mode(c));
            return new JSONObject().put("enabled", enabled()).put("cats", cats)
                    .put("adblock", adBlock()).toString();
        } catch (JSONException e) {
            return "{\"enabled\":false,\"cats\":{},\"adblock\":false}";
        }
    }
}
