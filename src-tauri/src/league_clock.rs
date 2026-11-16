use chrono::Utc;

const WEEK_SECONDS: i64 = 7 * 24 * 60 * 60;

fn allowed_preview_weeks(value: Option<&str>, development_build: bool) -> i64 {
    if !development_build {
        return 0;
    }
    value
        .and_then(|value| value.trim().parse::<i64>().ok())
        .filter(|weeks| (0..=104).contains(weeks))
        .unwrap_or(0)
}

/// Preview offsets never become persisted league settings. Release builds do
/// not read the environment variable and always use the real UTC clock.
pub(crate) fn preview_weeks() -> i64 {
    #[cfg(debug_assertions)]
    {
        let value = std::env::var("ETERNAL_LEAGUE_PREVIEW_WEEKS").ok();
        allowed_preview_weeks(value.as_deref(), true)
    }
    #[cfg(not(debug_assertions))]
    {
        allowed_preview_weeks(None, false)
    }
}

pub(crate) fn effective_now() -> i64 {
    shifted_now(Utc::now().timestamp(), preview_weeks())
}

fn shifted_now(real_now: i64, weeks: i64) -> i64 {
    real_now.saturating_add(weeks.saturating_mul(WEEK_SECONDS))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_preview_is_explicit_bounded_and_does_not_change_its_anchor() {
        assert_eq!(allowed_preview_weeks(Some("4"), true), 4);
        assert_eq!(allowed_preview_weeks(Some(" 104 "), true), 104);
        for value in [
            None,
            Some(""),
            Some("-1"),
            Some("105"),
            Some("4.5"),
            Some("four"),
        ] {
            assert_eq!(allowed_preview_weeks(value, true), 0);
        }
        let anchor = 1_794_801_597;
        assert_eq!(shifted_now(anchor, 4), anchor + 4 * WEEK_SECONDS);
        assert_eq!(shifted_now(anchor, 0), anchor);
    }

    #[test]
    fn production_policy_ignores_every_preview_value() {
        for value in [None, Some("0"), Some("4"), Some("104"), Some("invalid")] {
            assert_eq!(allowed_preview_weeks(value, false), 0);
        }
        #[cfg(not(debug_assertions))]
        assert_eq!(preview_weeks(), 0);
    }
}
