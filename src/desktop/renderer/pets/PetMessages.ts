import { DesktopLocale } from '#contracts/DesktopLocale.js';

const english = {
  pets: 'Pets',
  description: 'A little company while you learn.',
  cat: 'Cat',
  fox: 'Fox',
  slime: 'Slime',
  name: 'Pet name',
  adopt: 'Adopt pet',
  show: 'Show pet',
  save: 'Save name',
  hidden: 'Hidden',
  active: 'Active',
  pet: 'Pet',
  slap: 'Playful slap',
  hide: 'Hide pet',
  quiet: 'Quiet mode',
  quietHint: 'Turn off occasional encouragement.',
  reduced: 'Reduce motion',
  reducedHint: 'Use still poses. Otherwise, follow your system preference.',
  hint: 'Click a cat or fox to see its expressions. Slime also reacts to right-clicks. Drag the desktop pet to move it. Reduced motion keeps cats and foxes still. One pet is active at a time.',
  error: 'Could not update your pet. Try again.',
  unavailable: 'Pet controls are unavailable. Reopen Tro and try again.',
  presentationError:
    'The desktop pet could not open. You can still preview it here; try Show pet again.',
  encouragement: 'One small step at a time.',
  preview: 'Preview',
  signIn: 'Sign in to choose your pet.',
  generation: 'Custom pet generation is planned. For now, choose and name one of these pets.',
};

type PetMessages = typeof english;

const vietnamese: PetMessages = {
  pets: 'Thú cưng',
  description: 'Một người bạn nhỏ khi bạn học.',
  cat: 'Mèo',
  fox: 'Cáo',
  slime: 'Slime',
  name: 'Tên thú cưng',
  adopt: 'Nhận nuôi',
  show: 'Hiện thú cưng',
  save: 'Lưu tên',
  hidden: 'Đang ẩn',
  active: 'Đang chọn',
  pet: 'Vuốt ve',
  slap: 'Vỗ nhẹ',
  hide: 'Ẩn thú cưng',
  quiet: 'Chế độ yên lặng',
  quietHint: 'Tắt lời động viên thỉnh thoảng xuất hiện.',
  reduced: 'Giảm chuyển động',
  reducedHint: 'Dùng hình tĩnh. Nếu tắt, làm theo cài đặt hệ thống.',
  hint: 'Nhấp vào mèo hoặc cáo để xem biểu cảm. Slime còn phản ứng khi nhấp chuột phải. Kéo thú cưng trên màn hình để di chuyển. Chế độ giảm chuyển động giữ mèo và cáo đứng yên. Mỗi lần chỉ hiện một thú cưng.',
  error: 'Không thể cập nhật thú cưng. Hãy thử lại.',
  unavailable: 'Chưa thể dùng thú cưng. Hãy mở lại Tro và thử lại.',
  presentationError:
    'Không thể mở thú cưng trên màn hình. Bạn vẫn có thể xem thử tại đây; hãy thử hiện lại.',
  encouragement: 'Từng bước nhỏ một nhé.',
  preview: 'Xem thử',
  signIn: 'Đăng nhập để chọn thú cưng.',
  generation:
    'Tính năng tạo thú cưng riêng đang được lên kế hoạch. Hiện tại, hãy chọn và đặt tên cho một bạn dưới đây.',
};

export const petMessages = {
  [DesktopLocale.ENGLISH]: english,
  [DesktopLocale.VIETNAMESE]: vietnamese,
} satisfies Record<DesktopLocale, PetMessages>;
