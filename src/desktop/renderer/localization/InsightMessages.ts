import { DesktopLocale } from '#contracts/DesktopLocale.js';

const vietnamese: Readonly<Record<string, string>> = {
  'Learning insights': 'Tiến độ học tập',
  Refresh: 'Cập nhật',
  From: 'Từ ngày',
  Through: 'Đến ngày',
  'Apply period': 'Áp dụng khoảng thời gian',
  Student: 'Học sinh',
  'Learning insights are unavailable in this app version.':
    'Phiên bản ứng dụng này chưa hỗ trợ tiến độ học tập.',
  'Loading learning insights…': 'Đang tải tiến độ học tập…',
  'Learning insights are unavailable for this class. Collection permissions must be in place before the feature is enabled.':
    'Lớp này chưa có dữ liệu tiến độ học tập. Cần được cho phép thu thập dữ liệu trước khi bật tính năng.',
  'Learning insights could not be loaded.': 'Không thể tải tiến độ học tập.',
  'Choose valid dates.': 'Hãy chọn ngày hợp lệ.',
  'Choose an ordered reporting period of at most 186 days.':
    'Hãy chọn khoảng thời gian theo đúng thứ tự, tối đa 186 ngày.',
  'Student journey': 'Hành trình học tập',
  'Class insights': 'Tiến độ của lớp',
  'Parent report': 'Báo cáo phụ huynh',
  'Learning definitions': 'Tiêu chí học tập',
  'Choose a student to see saved work.': 'Chọn học sinh để xem bài đã lưu.',
  'Assigned students': 'Học sinh được giao bài',
  'From this lesson’s approved assignment': 'Theo bài tập đã duyệt của buổi học này',
  'Students with checked work': 'Học sinh có bài đã đánh giá',
  'Results within the selected period': 'Kết quả trong khoảng thời gian đã chọn',
  'No checked result shown': 'Chưa có kết quả đánh giá',
  'Unknown when assignment coverage is missing': 'Chưa xác định khi thiếu dữ liệu giao bài',
  'Tasks tried, skills shown and the next step.':
    'Bài tập đã thử, kỹ năng đã thể hiện và bước tiếp theo.',
  'Tasks handed in': 'Bài đã nộp',
  'Recorded hand-ins · assignment total unavailable':
    'Bài nộp đã ghi nhận · chưa có tổng số bài được giao',
  'From the teacher-approved assignment plan': 'Theo kế hoạch giao bài đã được giáo viên duyệt',
  'Skills shown in selected lesson': 'Kỹ năng thể hiện trong buổi học đã chọn',
  'Criteria met · support may be included': 'Tiêu chí đạt · có thể có hỗ trợ',
  'New tasks completed unaided': 'Bài mới hoàn thành không cần hỗ trợ',
  'Fresh or transfer tasks · teacher confirmed · across this period':
    'Bài mới hoặc bài vận dụng · giáo viên xác nhận · trong khoảng thời gian này',
  'Some earlier work is not shown.': 'Một số bài trước đây chưa được hiển thị.',
  'Your learning path': 'Lộ trình học tập của bạn',
  'Teacher-set task order. Select a task to see your work.':
    'Thứ tự bài tập do giáo viên đặt. Chọn bài để xem bài làm của bạn.',
  'Work handed in': 'Đã nộp bài',
  'Checked work recorded': 'Đã ghi nhận bài được đánh giá',
  'No hand-in shown': 'Chưa có bài nộp',
  'A teacher-approved task path has not been assigned yet.':
    'Chưa được giao lộ trình bài tập do giáo viên duyệt.',
  'Comparable skills and delayed checks': 'Kỹ năng có thể so sánh và đánh giá sau một thời gian',
  'Individual observation': 'Quan sát cá nhân',
  'Shared task context': 'Bối cảnh bài tập nhóm',
  'Individual context unknown': 'Chưa rõ bối cảnh cá nhân',
  'elapsed time unavailable': 'chưa có thời gian đã trôi qua',
  'No teacher-approved comparable skill history shown yet.':
    'Chưa có lịch sử kỹ năng có thể so sánh được giáo viên duyệt.',
  'Task detail': 'Chi tiết bài tập',
  'Teacher-approved criteria': 'Tiêu chí đã được giáo viên duyệt',
  'No checked work shown for this task.': 'Chưa có bài được đánh giá cho bài tập này.',
  Close: 'Đóng',
  'Skills shown by lesson': 'Kỹ năng thể hiện theo buổi học',
  'Checked criteria from your teacher’s lesson plan.':
    'Các tiêu chí đã đánh giá theo kế hoạch buổi học của giáo viên.',
  Met: 'Đạt',
  met: 'đạt',
  'Needs practice': 'Cần luyện tập',
  'No result shown': 'Chưa có kết quả',
  'Review needed': 'Cần xem lại',
  'No lesson results to show yet.': 'Chưa có kết quả buổi học để hiển thị.',
  'Lesson criteria': 'Tiêu chí buổi học',
  'How this is counted': 'Cách tính kết quả',
  'Each bar uses the approved criteria for that lesson. A result counts once per criterion, using the latest comparable finding. Met criteria may include support. Missing or conflicting results remain separate. These counts do not measure general ability.':
    'Mỗi cột dùng các tiêu chí đã duyệt cho buổi học đó. Mỗi tiêu chí được tính một lần theo kết quả so sánh được gần nhất. Tiêu chí đạt có thể bao gồm hỗ trợ. Kết quả thiếu hoặc mâu thuẫn được tách riêng. Các số liệu này không đo lường năng lực tổng quát.',
  'Next learning task': 'Bài tập tiếp theo',
  'Teacher-selected activity': 'Hoạt động do giáo viên chọn',
  'Selected by your teacher based on the learning plan and saved work.':
    'Giáo viên chọn dựa trên kế hoạch học tập và bài làm đã lưu.',
  'Task details are unavailable.': 'Chưa có chi tiết bài tập.',
  'Your teacher can choose the next activity after reviewing your work.':
    'Giáo viên có thể chọn hoạt động tiếp theo sau khi xem bài làm của bạn.',
  'Teacher-selected task': 'Bài tập do giáo viên chọn',
  'Next task selected.': 'Đã chọn bài tập tiếp theo.',
  'Select next task': 'Chọn bài tập tiếp theo',
  'Recent work': 'Bài làm gần đây',
  'Tasks and submitted work from the selected lesson.':
    'Bài tập và bài đã nộp trong buổi học đã chọn.',
  'Teacher observation': 'Quan sát của giáo viên',
  'Practice check': 'Đánh giá luyện tập',
  'More evidence needed': 'Cần thêm minh chứng',
  'View saved work': 'Xem bài đã lưu',
  'Teacher observation; no saved artifact attached.':
    'Quan sát của giáo viên; không có bài đã lưu đính kèm.',
  'Check details': 'Chi tiết đánh giá',
  'No approved comparable skill mapping attached':
    'Chưa có liên kết kỹ năng có thể so sánh đã được duyệt',
  'Submitted link': 'Liên kết đã nộp',
  'A link was handed in. Its contents were not captured as checked work.':
    'Đã nộp liên kết. Nội dung liên kết chưa được ghi nhận là bài đã đánh giá.',
  'No checked tasks shown for this lesson.': 'Chưa có bài tập đã đánh giá cho buổi học này.',
  'Loading saved work…': 'Đang tải bài đã lưu…',
  'No saved artifact is available for this observation.': 'Không có bài đã lưu cho quan sát này.',
  'Saved work': 'Bài đã lưu',
  'Historical assignment and support coverage is unknown.':
    'Chưa rõ mức độ đầy đủ của dữ liệu giao bài và hỗ trợ trước đây.',
  'Learning history removed.': 'Lịch sử học tập đã bị xóa.',
  '{name}’s learning journey': 'Hành trình học tập của {name}',
  'Saved data through revision {revision}': 'Dữ liệu đã lưu đến phiên bản {revision}',
  'Partial history:': 'Lịch sử chưa đầy đủ:',
  Criteria: 'Tiêu chí',
  'need practice': 'cần luyện tập',
  'no result shown': 'chưa có kết quả',
  'need review': 'cần xem lại',
  criteria: 'tiêu chí',
  ', comparison across lessons not established':
    ', chưa xác lập khả năng so sánh giữa các buổi học',
  'task observations in this comparison group': 'quan sát bài tập trong nhóm so sánh này',
  'Delayed check:': 'Đánh giá sau một thời gian:',
  '{days} days after the earlier task': '{days} ngày sau bài tập trước',
  '. Result and support remain attached to the task.':
    '. Kết quả và mức hỗ trợ vẫn gắn với bài tập.',
  '{count} observations of this task. Review their results and support separately.':
    '{count} quan sát của bài tập này. Xem riêng kết quả và mức hỗ trợ của từng quan sát.',
  Observed: 'Đã quan sát',
  saved: 'đã lưu',
  Source: 'Nguồn',
  version: 'phiên bản',
  cutoff: 'mốc dữ liệu',
  'Approved skill definition version {version}': 'Phiên bản định nghĩa kỹ năng đã duyệt {version}',
  unknown: 'chưa rõ',
  'Learning insights are unavailable for this class or account.':
    'Lớp hoặc tài khoản này chưa có dữ liệu tiến độ học tập.',
  'This view changed. Refresh before trying again.':
    'Dữ liệu đã thay đổi. Hãy cập nhật trước khi thử lại.',
  'This learning history has been removed.': 'Lịch sử học tập này đã bị xóa.',
  'Choose a shorter reporting period.': 'Hãy chọn khoảng thời gian báo cáo ngắn hơn.',
  'Check the selected task and form fields.':
    'Hãy kiểm tra bài tập đã chọn và các trường trong biểu mẫu.',
  'Learning insights could not be loaded. Try again.':
    'Không thể tải tiến độ học tập. Hãy thử lại.',
  'Teacher-confirmed unaided': 'Giáo viên xác nhận không có hỗ trợ',
  'With a hint': 'Có gợi ý',
  'With a demonstration': 'Có hướng dẫn mẫu',
  'Group work': 'Bài tập nhóm',
  'Recorded as unaided': 'Được ghi nhận không có hỗ trợ',
  'Support unknown': 'Chưa rõ mức hỗ trợ',
  'Ask your teacher for help': 'Nhờ giáo viên hỗ trợ',
  'Tell your teacher which part you want to work through.':
    'Cho giáo viên biết phần bạn muốn được hỗ trợ.',
  'What would you like help with?': 'Bạn muốn được hỗ trợ phần nào?',
  'Part of the task': 'Phần của bài tập',
  'Your teacher can see your request.': 'Giáo viên có thể xem yêu cầu của bạn.',
  'Send help request': 'Gửi yêu cầu hỗ trợ',
  'Latest saved findings through revision {revision}. A past result does not show who needs help right now.':
    'Kết quả đã lưu gần nhất đến phiên bản {revision}. Kết quả trước đây không cho biết ai đang cần hỗ trợ lúc này.',
  fresh: 'bài mới',
  transfer: 'bài vận dụng',
  delayed: 'đánh giá sau một thời gian',
  practice: 'luyện tập',
  active: 'đang hiệu lực',
  superseded: 'đã được thay thế',
  conflict: 'mâu thuẫn',
  removed: 'đã xóa',
  running: 'đang đánh giá',
  completed: 'đã hoàn thành',
  failed: 'thất bại',
  'Earlier work is not captured.': 'Bài làm trước đây chưa được ghi nhận.',
  'Imported saved snapshots and hand-ins; historical assignments, deleted evidence and support delivery remain unknown.':
    'Đã nhập bài đã lưu và bài nộp; chưa rõ dữ liệu giao bài trước đây, minh chứng đã xóa và việc cung cấp hỗ trợ.',
};

type InsightTextValues = Readonly<Record<string, string | number>>;

/** Supplies learning presentation copy to the existing desktop locale catalogs. */
export function readInsightMessages(locale: DesktopLocale): {
  translateInsight: (text: string, values?: InsightTextValues) => string;
} {
  return {
    translateInsight(text: string, values: InsightTextValues = {}): string {
      const translated = locale === DesktopLocale.VIETNAMESE ? (vietnamese[text] ?? text) : text;
      return translated.replace(/\{(\w+)\}/g, (placeholder: string, name: string) =>
        values[name] === undefined ? placeholder : String(values[name]),
      );
    },
  };
}
