package tools

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fetchRoundTripFunc func(*http.Request) (*http.Response, error)

func (f fetchRoundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

type interruptedFetchBody struct{}

func (interruptedFetchBody) Read(buf []byte) (int, error) {
	return copy(buf, "partial"), io.ErrUnexpectedEOF
}

//nolint:paralleltest // 测试替换标准 HTTP transport，父测试与子测试都必须串行。
func TestWebFetchReadFailure(t *testing.T) {
	cases := []struct {
		name string
		body io.Reader
		want string
	}{
		{
			name: "complete body",
			body: strings.NewReader("complete"),
			want: "HTTP 200 · text/plain · http://8.8.8.8/docs\n\ncomplete",
		},
		{
			name: "interrupted body",
			body: interruptedFetchBody{},
			want: "错误：读取失败：unexpected EOF",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			original := http.DefaultTransport

			t.Cleanup(func() { http.DefaultTransport = original })

			http.DefaultTransport = fetchRoundTripFunc(func(*http.Request) (*http.Response, error) {
				recorder := httptest.NewRecorder()
				recorder.Header().Set("Content-Type", "text/plain")
				response := recorder.Result()
				response.Body = io.NopCloser(tc.body)

				return response, nil
			})
			got := NewWebFetch().Run(context.Background(), map[string]any{"url": "http://8.8.8.8/docs"})

			if got != tc.want {
				t.Fatalf("web_fetch = %q，want %q", got, tc.want)
			}
		})
	}
}
