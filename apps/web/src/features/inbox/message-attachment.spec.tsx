import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MessageAttachment } from './message-attachment';

describe('message media', () => {
  it('shows the original photo and falls back to its preview before showing a usable error link', () => {
    const onLoad = vi.fn();
    render(
      <MessageAttachment
        attachment={{
          type: 'image',
          url: 'https://example.com/full.jpg',
          previewUrl: 'https://example.com/thumb.jpg',
          name: null,
        }}
        onLoad={onLoad}
      />,
    );
    const image = screen.getByRole('img', { name: 'Ảnh đính kèm' });
    expect(image).toHaveAttribute('src', 'https://example.com/full.jpg');
    fireEvent.load(image);
    expect(onLoad).toHaveBeenCalledOnce();
    fireEvent.error(image);
    expect(image).toHaveAttribute('src', 'https://example.com/thumb.jpg');
    expect(screen.getByRole('link', { name: 'Mở ảnh gốc' })).toHaveAttribute(
      'href',
      'https://example.com/full.jpg',
    );
    fireEvent.error(image);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Ảnh không còn khả dụng.',
    );
    expect(
      screen.getByRole('link', { name: 'Mở liên kết gốc' }),
    ).toHaveAttribute('href', 'https://example.com/full.jpg');
  });
  it('renders sticker assets as images and gracefully handles unresolved stickers', () => {
    const { rerender } = render(
      <MessageAttachment
        attachment={{ type: 'sticker', url: null, name: null }}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Sticker chưa có ảnh xem trước.',
    );
    rerender(
      <MessageAttachment
        attachment={{
          type: 'sticker',
          url: 'https://example.com/sticker.webp',
          name: null,
        }}
      />,
    );
    expect(screen.getByRole('img', { name: 'Sticker' })).toHaveAttribute(
      'src',
      'https://example.com/sticker.webp',
    );
    expect(screen.getByRole('link', { name: 'Mở sticker' })).toHaveAttribute(
      'rel',
      'noreferrer',
    );
  });
  it('never renders unsafe media URLs', () => {
    render(
      <MessageAttachment
        attachment={{
          type: 'image',
          url: 'javascript:alert(1)',
          previewUrl: 'data:image/png;base64,abc',
          name: null,
        }}
      />,
    );
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Ảnh chưa có liên kết tải.',
    );
  });
});
