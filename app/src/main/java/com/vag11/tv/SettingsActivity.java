package com.vag11.tv;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * The two menus opened from YouTube's Settings page. EXTRA_PAGE picks one:
 * "ads" is the ad blocker's switch; anything else is SponsorBlock, with one switch and then a mode
 * per segment category. OK changes the focused row.
 */
public class SettingsActivity extends Activity {
    static final String EXTRA_PAGE = "page";
    static final String PAGE_ADS = "ads";

    private Prefs prefs;
    private LinearLayout list;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = new Prefs(this);

        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(48);
        list.setPadding(pad * 2, pad, pad * 2, pad);

        TextView first = PAGE_ADS.equals(getIntent().getStringExtra(EXTRA_PAGE))
                ? buildAds() : buildSponsorBlock();

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xFF0F0F0F);
        scroll.addView(list);
        setContentView(scroll);
        first.requestFocus();
    }

    private TextView buildAds() {
        header("Ad blocking", "Removes adverts before and during videos, the Home banner and "
                + "Sponsored tiles. A change applies to the next video or page you open. "
                + "Press OK to change, Back to return.");
        TextView sw = row();
        sw.setText("Block ads:  " + onOff(prefs.adBlock()));
        sw.setOnClickListener(v -> {
            prefs.setAdBlock(!prefs.adBlock());
            sw.setText("Block ads:  " + onOff(prefs.adBlock()));
        });
        list.addView(sw);
        return sw;
    }

    private TextView buildSponsorBlock() {
        header("SponsorBlock", "Skips segments reported by the SponsorBlock community "
                + "(sponsor.ajay.app). Press OK to change a row, Back to return.");
        TextView master = row();
        master.setText("SponsorBlock:  " + onOff(prefs.enabled()));
        master.setOnClickListener(v -> {
            prefs.setEnabled(!prefs.enabled());
            master.setText("SponsorBlock:  " + onOff(prefs.enabled()));
        });
        list.addView(master);

        for (int i = 0; i < Prefs.CATS.length; i++) {
            final String cat = Prefs.CATS[i];
            final String name = Prefs.CAT_NAMES[i];
            TextView r = row();
            r.setText(name + ":  " + Prefs.MODE_NAMES[prefs.mode(cat)]);
            r.setOnClickListener(v -> {
                prefs.setMode(cat, (prefs.mode(cat) + 1) % Prefs.MODE_NAMES.length);
                r.setText(name + ":  " + Prefs.MODE_NAMES[prefs.mode(cat)]);
            });
            list.addView(r);
        }
        return master;
    }

    private static String onOff(boolean on) {
        return on ? "On" : "Off";
    }

    private void header(String titleText, String subText) {
        TextView title = text(titleText, 30, Color.WHITE);
        title.setPadding(dp(20), 0, 0, dp(6));
        list.addView(title);
        TextView sub = text(subText, 15, 0xFFAAAAAA);
        sub.setPadding(dp(20), 0, 0, dp(22));
        list.addView(sub);
    }

    private TextView row() {
        TextView v = text("", 20, Color.WHITE);
        v.setFocusable(true);
        v.setClickable(true);
        v.setGravity(Gravity.CENTER_VERTICAL);
        v.setPadding(dp(20), dp(14), dp(20), dp(14));
        StateListDrawable bg = new StateListDrawable();
        bg.addState(new int[]{android.R.attr.state_focused}, pill(0xFFF1F1F1));
        bg.addState(new int[]{}, pill(0x00000000));
        v.setBackground(bg);
        v.setOnFocusChangeListener((View view, boolean has) ->
                ((TextView) view).setTextColor(has ? 0xFF0F0F0F : Color.WHITE));
        return v;
    }

    private GradientDrawable pill(int color) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(10));
        return d;
    }

    private TextView text(String s, int sp, int color) {
        TextView v = new TextView(this);
        v.setText(s);
        v.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        v.setTextColor(color);
        return v;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
