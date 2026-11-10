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

/** The SponsorBlock menu: one switch, then a mode per segment category. OK cycles the mode. */
public class SponsorBlockSettingsActivity extends Activity {
    private Prefs prefs;

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);
        prefs = new Prefs(this);

        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(48);
        list.setPadding(pad * 2, pad, pad * 2, pad);

        TextView title = text("SponsorBlock", 30, Color.WHITE);
        title.setPadding(dp(20), 0, 0, dp(6));
        list.addView(title);
        TextView sub = text("Skips segments reported by the SponsorBlock community (sponsor.ajay.app). "
                + "Press OK to change a row, Back to return.", 15, 0xFFAAAAAA);
        sub.setPadding(dp(20), 0, 0, dp(22));
        list.addView(sub);

        TextView master = row();
        bindMaster(master);
        master.setOnClickListener(v -> {
            prefs.setEnabled(!prefs.enabled());
            bindMaster(master);
        });
        list.addView(master);

        for (int i = 0; i < Prefs.CATS.length; i++) {
            final String cat = Prefs.CATS[i];
            final String name = Prefs.CAT_NAMES[i];
            TextView r = row();
            bindCat(r, cat, name);
            r.setOnClickListener(v -> {
                prefs.setMode(cat, (prefs.mode(cat) + 1) % Prefs.MODE_NAMES.length);
                bindCat(r, cat, name);
            });
            list.addView(r);
        }

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(0xFF0F0F0F);
        scroll.addView(list);
        setContentView(scroll);
        master.requestFocus();
    }

    private void bindMaster(TextView v) {
        v.setText("SponsorBlock:  " + (prefs.enabled() ? "On" : "Off"));
    }

    private void bindCat(TextView v, String cat, String name) {
        v.setText(name + ":  " + Prefs.MODE_NAMES[prefs.mode(cat)]);
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
